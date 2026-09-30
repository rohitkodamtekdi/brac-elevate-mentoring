const common = require('@constants/common')
const httpStatusCode = require('@generics/http-status')
const utils = require('@generics/utils')
const kafkaCommunication = require('@generics/kafka-communication')
const sessionQueries = require('@database/queries/sessions')
const sessionAttendeesQueries = require('@database/queries/sessionAttendees')
const notificationTemplateQueries = require('@database/queries/notificationTemplate')
const mentorQueries = require('@database/queries/mentorExtension')
const menteeQueries = require('@database/queries/userExtension')
const adminService = require('../generics/materializedViews')
const responses = require('@helpers/responses')
const requestSessionQueries = require('@database/queries/requestSessions')
const userRequests = require('@requests/user')
const communicationHelper = require('@helpers/communications')
const moment = require('moment')
const connectionQueries = require('@database/queries/connection')
const userExtensionQueries = require('@database/queries/userExtension')
const { getDefaults } = require('@helpers/getDefaultOrgId')
const { Op, QueryTypes } = require('sequelize')
const { sequelize, Session, SessionAttendee, Connection, RequestSession } = require('@database/models/index')
const { literal } = require('sequelize')
const sessionRequestMappingQueries = require('@database/queries/requestSessionMapping')
const permissionsQueries = require('@database/queries/permissions')
const entityTypeHelper = require('@helpers/entityTypeCache')
const orgQueries = require('@database/queries/organisationExtension')
const formQueries = require('@database/queries/form')
const cacheHelper = require('@generics/cacheHelper')
const emailEncryption = require('@utils/emailEncryption')
// sessionOwnership removed - functionality replaced by direct Session queries

// Generic notification helper class
class NotificationHelper {
	static async sendGenericNotification({
		recipients,
		templateCode,
		orgCode,
		templateData = {},
		subjectData = {},
		tenantCode,
	}) {
		try {
			if (!templateCode || !recipients?.length) {
				console.log('Missing template code or recipients for notification')
				return true
			}

			// Handle arrays: extract first value (user codes), cacheHelper will fallback to defaults if not found
			const userOrgCode = Array.isArray(orgCode) ? orgCode[0] : orgCode

			// cacheHelper.get will automatically search user codes first, then defaults when cache is disabled
			const template = await cacheHelper.notificationTemplates.get(tenantCode, userOrgCode, templateCode)
			if (!template) {
				console.log(`Template ${templateCode} not found`)
				return true
			}

			const emailPromises = recipients.map(async (recipient) => {
				const payload = {
					type: 'email',
					email: {
						to: recipient.email,
						subject: utils.composeEmailBody(template.subject, {
							...subjectData,
							recipientName: recipient.name,
						}),
						body: utils.composeEmailBody(template.body, { ...templateData, recipientName: recipient.name }),
					},
				}
				await kafkaCommunication.pushEmailToKafka(payload)
			})

			await Promise.all(emailPromises)
			console.log(`Sent ${recipients.length} notifications using template ${templateCode}`)
			return true
		} catch (error) {
			console.error(`Error sending generic notification (${templateCode}):`, error)
			return false
		}
	}

	static async sendSessionNotification({
		sessions,
		templateCode,
		orgCode,
		recipientField = 'mentee_id',
		addionalData = {},
		tenantCode,
		orgCodes,
	}) {
		try {
			if (!sessions?.length || !templateCode) return true

			// Handle arrays: extract first value (user codes), cacheHelper will fallback to defaults if not found
			const userTenantCode = tenantCode
			const userOrgCode = Array.isArray(orgCode) ? orgCode[0] : orgCode

			// cacheHelper.get will automatically search user codes first, then defaults when cache is disabled
			const template = await cacheHelper.notificationTemplates.get(tenantCode, userOrgCode, templateCode)
			if (!template) {
				console.log(`Template ${templateCode} not found`)
				return true
			}

			for (const session of sessions) {
				const recipientIds =
					recipientField === 'attendees'
						? await this.getSessionAttendeeIds(session.id, tenantCode)
						: [session[recipientField]]

				const recipients = await menteeQueries.getUsersByUserIds(recipientIds, {}, tenantCode, true)

				const emailPromises = recipients.map(async (recipient) => {
					const templateData = {
						...addionalData,
						sessionName: session.title,
						sessionDate: session.start_date ? moment.unix(session.start_date).format('DD-MM-YYYY') : '',
						sessionTime: session.start_date ? moment.unix(session.start_date).format('hh:mm A') : '',
						Date: session.start_date ? moment.unix(session.start_date).format('DD-MM-YYYY') : '',
						Time: session.start_date ? moment.unix(session.start_date).format('hh:mm A') : '',
						recipientName: recipient.name,
						attendeeName: recipient.name,
						nameOfTheSession: session.title,
					}

					const payload = {
						type: 'email',
						email: {
							to: recipient.email,
							subject: utils.composeEmailBody(template.subject, templateData),
							body: utils.composeEmailBody(template.body, templateData),
						},
					}
					await kafkaCommunication.pushEmailToKafka(payload)
				})

				await Promise.all(emailPromises)
			}

			return true
		} catch (error) {
			console.error(`Error sending session notification (${templateCode}):`, error)
			return false
		}
	}

	static async getSessionAttendeeIds(sessionId, tenantCode) {
		try {
			const attendees = await sessionAttendeesQueries.findAll({ session_id: sessionId }, tenantCode)
			return attendees.map((attendee) => attendee.mentee_id)
		} catch (error) {
			console.error('Error getting session attendee IDs:', error)
			return []
		}
	}
}

module.exports = class AdminService {
	/**
	 * userDelete
	 * @method
	 * @name userDelete
	 * @param {userId} userId - UserId of the user that needs to be deleted
	 * @returns {JSON} - List of users
	 */

	static async userDelete(userId, currentUserId, organizationCode, tenantCode, token = '', isAdmin = false) {
		try {
			let result = {}

			// Step 1: Fetch user details
			let userInfo = null
			let userTenantCode = tenantCode

			// Optimization: If admin, query directly without tenant restriction (1 query)
			// If regular user (self-deletion), use tenant code from token (1 query)
			if (isAdmin) {
				// Admin deleting any user - no tenant code restriction
				const userDetail = await menteeQueries.getMenteeExtensionById(userId, [], true)
				userTenantCode = userDetail?.tenant_code
				userInfo = userDetail || null
			} else {
				// Regular user deleting themselves - use tenant code from token (optimized path)
				const getUserDetails = await menteeQueries.getUsersByUserIds([userId], {}, tenantCode)
				userInfo = getUserDetails?.[0]
			}

			if (!userInfo) {
				return responses.failureResponse({
					statusCode: httpStatusCode.bad_request,
					message: 'USER_NOT_FOUND',
					result,
				})
			}
			const isMentor = userInfo.is_mentor === true

			// Step 2: Check if user is a session manager
			// Use the user's actual tenant code for fetching user details
			const getUserDetailById = await userRequests.fetchUserDetails({ token, userId, userTenantCode }) // userId = "1"
			const roleTitles = getUserDetailById?.data?.result?.user_roles?.map((r) => r.title) || []
			const isSessionManager = roleTitles.includes(common.SESSION_MANAGER_ROLE)

			// Step 3: Optional logic to mark Session Manager as UNDER_DELETION
			// const isAlreadyUnderDeletion = userInfo.status === common.UNDER_DELETION_STATUS;
			// if (isSessionManager) {
			// 	if (isAlreadyUnderDeletion) {
			// 		return responses.failureResponse({
			// 			statusCode: httpStatusCode.bad_request,
			// 			message: 'USER_ALREADY_UNDER_DELETION',
			// 			result,
			// 		});
			// 	}

			// 	const updateData = { status: common.UNDER_DELETION_STATUS };

			// 	if (isMentor) {
			// 		await mentorQueries.updateMentorExtension(userId, updateData, true);
			// 	} else {
			// 		await menteeQueries.updateMenteeExtension(userId, updateData, true);
			// 	}

			// 	return responses.successResponse({
			// 		statusCode: httpStatusCode.ok,
			// 		message: 'USER_UNDER_DELETION',
			// 		result,
			// 	});
			// }

			// Prevent deletion of session manager directly
			if (isSessionManager) {
				return responses.failureResponse({
					statusCode: httpStatusCode.bad_request,
					message: 'SESSION_MANAGER_DELETION_UNSUCCESSFUL',
					result,
				})
			}

			// Get defaults early for use in notifications
			const defaults = await getDefaults()

			// Step 4: Check for user connections
			// Use user's actual tenant code for connection queries
			const connectionCount = await connectionQueries.getConnectionsCount('', userId, [], userTenantCode) // filter, userId = "1", organizationIds = ["1", "2"]

			if (connectionCount > 0) {
				let mentorIds = await connectionQueries.getConnectedUsers(
					userId,
					'user_id',
					'friend_id',
					userTenantCode
				)
				if (mentorIds.length === 0) {
					// Continue with deletion process even if no mentors are connected
					mentorIds = []
				}
				// Get mentor details for notification
				const connectedMentors = await userExtensionQueries.getUsersByUserIds(
					mentorIds,
					{
						attributes: ['user_id', 'name', 'email'],
					},
					userTenantCode
				)

				// Soft delete in communication service - handle invalid-users gracefully
				let removeChatUser, removeChatAvatar, updateChatUserName

				try {
					removeChatUser = await communicationHelper.setActiveStatus(userId, false, false, userTenantCode) // ( userId = "1", activeStatus = "true" or "false")
				} catch (error) {
					console.log(`Communication setActiveStatus failed:`, error.response?.data?.message || error.message)
					removeChatUser = { result: { success: false }, error: error.message }
				}

				try {
					removeChatAvatar = await communicationHelper.removeAvatar(userId, userTenantCode)
				} catch (error) {
					console.log(`Communication removeAvatar failed:`, error.response?.data?.message || error.message)
					removeChatAvatar = { result: { success: false }, error: error.message }
				}

				// Update user name to 'User Not Found'
				try {
					updateChatUserName = await communicationHelper.updateUser(
						userId,
						common.USER_NOT_FOUND,
						userTenantCode
					) // userId: "1", name: "User Name"
				} catch (error) {
					console.log(`Communication updateUser failed:`, error.response?.data?.message || error.message)
					updateChatUserName = { result: { success: false }, error: error.message }
				}

				result.isChatUserRemoved = removeChatUser?.result?.success === true
				result.isRemoveChatAvatar = removeChatAvatar?.result?.success === true
				result.isChatNameUpdated = updateChatUserName?.result?.success === true

				if (isMentor) {
					// 1. Notify connected mentees about mentor deletion
					const menteeIds = await connectionQueries.getConnectedUsers(
						userId,
						'friend_id',
						'user_id',
						userTenantCode
					)
					const connectedMentees = await userExtensionQueries.getUsersByUserIds(
						menteeIds,
						{
							attributes: ['user_id', 'name', 'email'],
						},
						userTenantCode,
						true
					)

					if (connectedMentees.length > 0) {
						const orgCodes = [userInfo.organization_code, defaults.orgCode].filter(Boolean)
						result.isMenteeNotifiedAboutMentorDeletion = await this.notifyMenteesAboutMentorDeletion(
							connectedMentees,
							userInfo.name || 'Mentor',
							orgCodes,
							userTenantCode
						)
					} else {
						result.isMenteeNotifiedAboutMentorDeletion = true
					}
				} else {
					// User is not a mentor, so no mentees to notify
					result.isMenteeNotifiedAboutMentorDeletion = true
				}

				// Delete user connections and requests from DB
				result.isConnectionsAndRequestsRemoved = await connectionQueries.deleteUserConnectionsAndRequests(
					userId,
					userTenantCode
				) // userId = "1"

				// Notify connected mentors about mentee deletion
				if (connectedMentors.length > 0 && !isMentor) {
					const orgCodes = [userInfo.organization_code, defaults.orgCode].filter(Boolean)

					result.isMentorNotifiedAboutMenteeDeletion = await this.notifyMentorsAboutMenteeDeletion(
						connectedMentors,
						userInfo.name || 'User',
						orgCodes,
						userTenantCode
					)
				} else {
					result.isMentorNotifiedAboutMenteeDeletion = true
				}
			} else {
				// No connections exist, set chat flags to true since no action needed
				result.isChatUserRemoved = true
				result.isChatNameUpdated = true
				result.isRemoveChatAvatar = true
				result.isConnectionsAndRequestsRemoved = true
				result.isMentorNotifiedAboutMenteeDeletion = true
				result.isMenteeNotifiedAboutMentorDeletion = true
			}

			// Step 6: Remove user and sessions
			let removedUserDetails = 0

			let mentorDetailsRemoved = 0
			let menteeDetailsRemoved = 0

			if (isMentor) {
				// Handle mentor-specific deletion tasks
				await this.handleMentorDeletion(userId, userInfo, result, userTenantCode)
				mentorDetailsRemoved = result.mentorDetailsRemoved
			}

			// Step 5: Session Request Deletion & Notifications
			const requestSessions = await this.findAllRequestSessions(userId, userTenantCode) // userId = "1"

			if (!defaults.orgCode)
				return responses.failureResponse({
					message: 'DEFAULT_ORG_CODE_NOT_SET',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			if (!defaults.tenantCode)
				return responses.failureResponse({
					message: 'DEFAULT_TENANT_CODE_NOT_SET',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})

			if (requestSessions.allSessionRequestIds.length > 0) {
				const { allSessionRequestIds = [], requestedSessions = [], receivedSessions = [] } = requestSessions

				// Collect all session request IDs for deletion
				result.isRequestedSessionRemoved = await requestSessionQueries.markRequestsAsDeleted(
					allSessionRequestIds,
					userTenantCode
				) // allSessionRequestIds = ["1", "2"]

				// Use both user's codes and defaults for notification templates
				const orgCodes = [organizationCode, defaults.orgCode].filter(Boolean)

				if (requestedSessions.length > 0) {
					result.isRequestedSessionMentorNotified = await this.NotifySessionRequestedUsers(
						requestedSessions,
						false,
						true,
						orgCodes,
						organizationCode,
						userTenantCode
					) // (sessionsDetails, received, sent, orgCodes, orgCode, tenantCode)
				}

				if (isMentor && receivedSessions.length > 0) {
					result.isRequestedSessionMenteeNotified = await this.NotifySessionRequestedUsers(
						receivedSessions,
						true,
						false,
						orgCodes,
						organizationCode,
						userTenantCode
					) // (sessionsDetails, received, sent, orgCodes, orgCode, tenantCode)
				}
			}

			await this.notifySessionManagerIfMenteeDeleted(userId, userInfo, result, userTenantCode)

			// Always check and remove mentee extension (user can be both mentor and mentee)
			try {
				menteeDetailsRemoved = await menteeQueries.deleteMenteeExtension(userId, userTenantCode) // userId = "1"

				// Cache invalidation: Clear mentee cache after removal
				if (menteeDetailsRemoved > 0) {
					try {
						await cacheHelper.mentee.delete(userTenantCode, userId)
					} catch (cacheError) {
						console.error(`Cache deletion failed for mentee ${userId}:`, cacheError)
					}
				}
			} catch (error) {
				console.log('No mentee extension found or already removed:', error.message)
			}

			// User details are cleared if either mentor or mentee details were removed
			removedUserDetails = mentorDetailsRemoved + menteeDetailsRemoved
			result.areUserDetailsCleared = removedUserDetails > 0

			// Get private sessions where deleted mentee was the only attendee
			const privateSessions = await sessionQueries.getUpcomingSessionsOfMentee(
				userId,
				common.SESSION_TYPE.PRIVATE,
				userTenantCode
			)

			// increment seats_remaining
			try {
				const upcomingPublicSessions = await sessionQueries.getUpcomingSessionsOfMentee(
					userId,
					common.SESSION_TYPE.PUBLIC,
					userTenantCode
				)
				// Ensure both are arrays before spreading
				const privateSessArray = Array.isArray(privateSessions) ? privateSessions : []
				const publicSessArray = Array.isArray(upcomingPublicSessions) ? upcomingPublicSessions : []
				const allUpcomingSessions = [...privateSessArray, ...publicSessArray]
				for (const session of allUpcomingSessions) {
					await sessionQueries.updateRecords(
						{ seats_remaining: literal('seats_remaining + 1') },
						{ where: { id: session.id, tenant_code: userTenantCode } }
					)

					// Cache invalidation: Clear session cache after seats_remaining update
					try {
						await cacheHelper.sessions.delete(userTenantCode, session.id)
					} catch (cacheError) {
						console.error(`Cache deletion failed for session ${session.id}:`, cacheError)
					}
				}
				result.isSeatsUpdate = true
			} catch (error) {
				console.error('Error handling while session seats_remaining updating:', error)
				result.isSeatsUpdate = false
			}

			// Step 7: Handle private session cancellations and notifications
			try {
				if (privateSessions.length > 0) {
					const orgCodes = [userInfo.organization_code, defaults.orgCode].filter(Boolean)

					result.isPrivateSessionsCancelled = await this.notifyAndCancelPrivateSessions(
						privateSessions,
						orgCodes,
						userTenantCode
					)
				} else {
					result.isPrivateSessionsCancelled = true
				}
			} catch (error) {
				console.error('Error handling private session cancellations:', error)
				result.isPrivateSessionsCancelled = false
			}

			// Step 8: Remove user from ALL sessions (attendees and enrollments) - not just upcoming
			try {
				const sessionCleanup = await sessionAttendeesQueries.removeUserFromAllSessions(userId, userTenantCode)
				result.isUnenrolledFromSessions = sessionCleanup.attendeeResult >= 0
			} catch (error) {
				console.error('Error removing user from all sessions:', error)
				result.isUnenrolledFromSessions = false
			}

			// Step 9: Final Response
			const allOperationsSuccessful =
				result.isUnenrolledFromSessions &&
				result.areUserDetailsCleared &&
				result.isMentorNotifiedAboutMenteeDeletion !== false &&
				result.isPrivateSessionsCancelled !== false &&
				result.isMenteeNotifiedAboutMentorDeletion !== false &&
				result.isSessionRequestsRejected !== false &&
				result.isSessionManagerNotified !== false &&
				result.isAssignedSessionsUpdated !== false

			if (allOperationsSuccessful) {
				return responses.successResponse({
					statusCode: httpStatusCode.ok,
					message: 'USER_REMOVED_SUCCESSFULLY',
					result,
					tenantCode,
					orgCode: organizationCode,
				})
			}
			return responses.failureResponse({
				statusCode: httpStatusCode.bad_request,
				message: 'USER_NOT_REMOVED_SUCCESSFULLY',
				result,
			})
		} catch (error) {
			console.error('An error occurred in userDelete:', error)
			return responses.failureResponse({
				statusCode: httpStatusCode.internal_server_error,
				message: 'USER_DELETION_FAILED',
				result: { error: error.message },
			})
		}
	}

	// Session Manager Deletion Flow Codes

	// static async assignNewSessionManager(decodedToken, oldSessionManagerId, newSessionManagerId, orgAdminUserId) {
	// 	if (!decodedToken.roles.some((role) => role.title === common.ADMIN_ROLE)) {
	// 		return responses.failureResponse({
	// 			message: 'UNAUTHORIZED_REQUEST',
	// 			statusCode: httpStatusCode.unauthorized,
	// 			responseCode: 'UNAUTHORIZED',
	// 		})
	// 	}

	// 	let result = {}

	// 	const getUserDetails = await menteeQueries.getUsersByUserIds([oldSessionManagerId])
	// 	if (getUserDetails.length <= 0) {
	// 		return responses.failureResponse({
	// 			statusCode: httpStatusCode.bad_request,
	// 			message: 'USER_NOT_FOUND',
	// 			result,
	// 		})
	// 	}

	// 	const userInfo = getUserDetails[0]
	// 	const isMentor = userInfo.isMentor === true
	// 	const isAlreadyUnderDeletion = userInfo.status === common.UNDER_DELETION_STATUS

	// 	// ✅ Step 1: Validate using org policy helper
	// 	const policyValidationResponse = await this.validateSessionReassignmentPolicies(
	// 		oldSessionManagerId,
	// 		newSessionManagerId,
	// 		orgAdminUserId
	// 	)
	// 	// If policy validation fails, return directly
	// 	if (policyValidationResponse.statusCode === httpStatusCode.bad_request) {
	// 		return policyValidationResponse
	// 	}

	// 	// If user is not under deletion
	// 	if (!isAlreadyUnderDeletion) {
	// 		return responses.failureResponse({
	// 			statusCode: httpStatusCode.bad_request,
	// 			message: 'USER_DELETION_NOT_INITIATED',
	// 			result,
	// 		})
	// 	}

	// 	// ✅ Step 2: Proceed with reassignment logic
	// 	let updateSessionsByNewSessionManager
	// 	let removedUserDetails

	// 	const isSessionManager = true // Based on logic context, assuming already validated

	// 	if (isSessionManager && isMentor) {
	// 		updateSessionsByNewSessionManager = await sessionQueries.replaceSessionManagerAndReturn(
	// 			oldSessionManagerId,
	// 			newSessionManagerId,
	// 			orgAdminUserId
	// 		)
	// 		removedUserDetails = await mentorQueries.removeMentorDetails(oldSessionManagerId)
	// 			const removedSessionsDetail = await sessionQueries.removeAndReturnMentorSessions(oldSessionManagerId)
	// 			result.isAttendeesNotified = await this.unenrollAndNotifySessionAttendees(
	// 				removedSessionsDetail,
	// 				userInfo.organization_id ? userInfo.organization_id : ''
	// 			)
	// 	} else if (isSessionManager) {
	// 		updateSessionsByNewSessionManager = await sessionQueries.replaceSessionManagerAndReturn(
	// 			oldSessionManagerId,
	// 			newSessionManagerId
	// 		)

	// 		removedUserDetails = await menteeQueries.removeMenteeDetails(oldSessionManagerId)
	// 	}

	// 	result.sessionsUpdated = updateSessionsByNewSessionManager
	// 	return responses.successResponse({
	// 		statusCode: httpStatusCode.ok,
	// 		message: 'SESSION_MANAGER_REASSIGNED_SUCCESSFULLY',
	// 		result,
	// 	})
	// }

	static async NotifySessionRequestedUsers(
		sessionsDetails,
		received = false,
		sent = false,
		orgCodes,
		orgCode,
		tenantCode
	) {
		try {
			const templateCode = received
				? process.env.MENTEE_SESSION_REQUEST_DELETION_EMAIL_CODE
				: process.env.MENTOR_SESSION_REQUEST_DELETION_EMAIL_CODE

			const sessionsWithRecipients = sessionsDetails.map((session) => ({
				...session,
				recipient_id: received ? session.requestor_id : session.requestee_id,
			}))

			return await NotificationHelper.sendSessionNotification({
				sessions: sessionsWithRecipients,
				templateCode,
				orgCode,
				recipientField: 'recipient_id',
				addionalData: { nameOfTheSession: '{sessionName}' },
				tenantCode,
				orgCodes,
			})
		} catch (error) {
			console.error('An error occurred in NotifySessionRequestedUsers:', error)
			return false
		}
	}

	static async unenrollAndNotifySessionAttendees(removedSessionsDetail, orgCodes = [], tenantCode, orgCode) {
		try {
			// Use first organization and tenant codes for notification
			const orgsCode = Array.isArray(orgCodes) ? orgCodes[0] : orgCodes

			// Send notifications using generic helper
			const notificationResult = await NotificationHelper.sendSessionNotification({
				sessions: removedSessionsDetail,
				templateCode: process.env.MENTOR_SESSION_DELETION_EMAIL_CODE,
				orgCode,
				recipientField: 'attendees',
				addionalData: { nameOfTheSession: '{sessionName}' },
				tenantCode,
				orgsCode,
			})

			// Unenroll attendees from sessions
			const sessionIds = removedSessionsDetail.map((session) => session.id)
			const unenrollDetails = await sessionAttendeesQueries.unEnrollAllAttendeesOfSessions(sessionIds, tenantCode)
			if (unenrollDetails && unenrollDetails.deletedCount > 0 && Array.isArray(unenrollDetails.deletedRecords)) {
				for (const menteeData of unenrollDetails.deletedRecords) {
					try {
						await cacheHelper.mentee.delete(tenantCode, menteeData.mentee_id)
					} catch (cacheError) {
						console.error(`Cache deletion failed for mentee ${menteeData.mentee_id}:`, cacheError)
					}
				}
			}

			return notificationResult
		} catch (error) {
			console.error('An error occurred in notifySessionAttendees:', error)
			return false
		}
	}

	static async unenrollFromUpcomingSessions(userId, tenantCode) {
		try {
			const upcomingSessions = await sessionQueries.getAllUpcomingSessions(false, tenantCode)

			const upcomingSessionsId = Array.isArray(upcomingSessions)
				? upcomingSessions.map((session) => session.id)
				: []
			const usersUpcomingSessions = await sessionAttendeesQueries.usersUpcomingSessions(
				userId,
				upcomingSessionsId,
				tenantCode
			)
			if (usersUpcomingSessions.length === 0) {
				return true
			}
			await Promise.all(
				usersUpcomingSessions.map(async (session) => {
					await sessionQueries.updateEnrollmentCount(session.session_id, true, tenantCode)

					// Cache invalidation: Clear session cache after enrollment count update
					const sessionDetail = upcomingSessions.find((s) => s.id === session.session_id)
					if (sessionDetail) {
						try {
							await cacheHelper.sessions.delete(tenantCode, session.session_id)
						} catch (cacheError) {
							console.error(`Cache deletion failed for session ${session.session_id}:`, cacheError)
						}
					}
				})
			)

			const unenrollFromUpcomingSessions = await sessionAttendeesQueries.unenrollFromUpcomingSessions(
				userId,
				upcomingSessionsId,
				tenantCode
			)
			return true
		} catch (error) {
			console.error('An error occurred in unenrollFromUpcomingSessions:', error)
			return error
		}
	}

	static async findAllRequestSessions(userId, tenantCode) {
		try {
			// Get requests where user is requestor (sent requests)
			const sentRequests = await requestSessionQueries.getAllRequests(
				userId,
				common.CONNECTIONS_STATUS.REQUESTED,
				tenantCode
			)
			const sentRequestsData = sentRequests.rows || []

			// Get requests where user is requestee (received requests)
			const sessionRequestMapping = await sessionRequestMappingQueries.getSessionsMapping(
				userId,
				null,
				tenantCode
			)
			const sessionRequestIds = Array.isArray(sessionRequestMapping) ? sessionRequestMapping.map((s) => s.id) : []

			const receivedRequests = await requestSessionQueries.getSessionMappingDetails(
				sessionRequestIds,
				common.CONNECTIONS_STATUS.REQUESTED,
				tenantCode
			)
			const receivedRequestsData = receivedRequests || []

			// Combine and process all requests
			const allData = [
				...sentRequestsData.map((req) => ({ ...req, request_type: 'sent' })),
				...receivedRequestsData.map((req) => ({ ...req.dataValues, request_type: 'received' })),
			]

			if (allData.length === 0) {
				return {
					allSessionRequestIds: [],
					requestedSessions: [],
					receivedSessions: [],
				}
			}

			const allSessionRequestIds = []
			const requestedSessions = []
			const receivedSessions = []

			for (const sessionRequest of allData) {
				allSessionRequestIds.push(sessionRequest.id)

				if (sessionRequest.request_type === 'sent') {
					requestedSessions.push(sessionRequest) // full data
				} else if (sessionRequest.request_type === 'received') {
					receivedSessions.push(sessionRequest) // full data
				}
			}

			return {
				allSessionRequestIds, // array of IDs
				requestedSessions, // array of objects
				receivedSessions, // array of objects
			}
		} catch (error) {
			console.error('Error in findAllRequestSessions:', error)
			return {
				allSessionRequestIds: [],
				requestedSessions: [],
				receivedSessions: [],
			}
		}
	}

	static async triggerViewRebuild() {
		try {
			let result
			let message

			// Build operation: ALWAYS build views for ALL tenants - no parameters needed
			result = await adminService.triggerViewBuildForAllTenants()
			message = result.success ? result.message : 'MATERIALIZED_VIEW_GENERATION_FAILED'

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: message,
				result: result,
			})
		} catch (error) {
			console.error('An error occurred in triggerViewRebuild:', error)
			return error
		}
	}
	static async triggerPeriodicViewRefresh(decodedToken, tenantCode, modelName) {
		try {
			let result
			let message

			if (modelName && tenantCode) {
				// Specific model and tenant provided - refresh specific view for specific tenant
				result = await adminService.refreshMaterializedView(modelName, tenantCode)
				message = 'MATERIALIZED_VIEW_REFRESH_INITIATED_SUCCESSFULLY'
			} else if (!tenantCode) {
				// No tenantCode provided - start refresh for all tenants (with specific model if provided)
				result = await adminService.triggerPeriodicViewRefreshForAllTenants(modelName)
				message = result.success ? result.message : 'MATERIALIZED_VIEW_REFRESH_FAILED'
			} else {
				// Specific tenantCode provided - start refresh for that tenant only
				result = await adminService.triggerPeriodicViewRefresh(tenantCode)
				message = 'MATERIALIZED_VIEW_REFRESH_INITIATED_SUCCESSFULLY'
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: message,
				result: result,
			})
		} catch (error) {
			console.error('An error occurred in triggerPeriodicViewRefresh:', error)
			return error
		}
	}
	static async triggerPeriodicViewRefreshInternal(modelName, tenantCode) {
		try {
			const result = await adminService.refreshMaterializedView(modelName, tenantCode)
			// Only log if there's an actual refresh or error
			if (result && result.rowCount) {
				console.log(`Materialized view refreshed for ${modelName}, tenant: ${tenantCode}`)
			}
			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'MATERIALIZED_VIEW_REFRESH_INITIATED_SUCCESSFULLY',
				tenantCode: tenantCode,
			})
		} catch (error) {
			console.error('An error occurred in userDelete:', error)
			return error
		}
	}

	static async notifyAndCancelPrivateSessions(privateSessions, orgCodes, tenantCode) {
		const transaction = await sequelize.transaction()
		try {
			let allNotificationsSent = true

			for (const session of privateSessions) {
				// Check if this is a one-on-one session (only one attendee)
				const attendeeCount = await sessionAttendeesQueries.getCount({
					session_id: session.id,
					tenant_code: tenantCode, // Use primary tenant for database query
				})

				if (attendeeCount === 1 && session.mentor_id == session.created_by) {
					// This is a one-on-one private session, cancel it and notify mentor
					const notificationSent = await this.notifyMentorAboutPrivateSessionCancellation(
						session.mentor_id,
						session,
						orgCodes,
						tenantCode
					)

					if (!notificationSent) {
						allNotificationsSent = false
					}

					// Mark session as cancelled/deleted
					await sessionQueries.updateRecords(
						{ deleted_at: new Date() },
						{ where: { id: session.id, tenant_code: tenantCode } }, // Use primary tenant for database query
						transaction
					)
					// sessionOwnership deletion removed - no longer needed with direct Session mentor_id management

					console.log(`Cancelled private session ${session.id} due to mentee deletion`)
				}
			}
			await transaction.commit()
			return allNotificationsSent
		} catch (error) {
			await transaction.rollback()
			console.error('Error notifying and cancelling private sessions:', error)
			return false
		}
	}

	// Session Manager Deletion Flow Codes

	// static async validateSessionReassignmentPolicies(oldSessionManagerId, newSessionManagerId, orgAdminUserId) {
	// 	try {
	// 		const userIds = Array.from(new Set([oldSessionManagerId, newSessionManagerId, orgAdminUserId])); // avoid duplicate fetch
	// 		const userDetailsResponse = await userRequests.getListOfUserDetails(userIds, true);
	// 		const users = userDetailsResponse?.result || [];
	// 		const getUserById = (id) => users.find(u => u.id === id);
	// 		const oldSMUser = getUserById(oldSessionManagerId);
	// 		const newSMUser = getUserById(newSessionManagerId);
	// 		const orgAdminUser = getUserById(orgAdminUserId);

	// 		if (!oldSMUser) {
	// 			return responses.failureResponse({
	// 				statusCode: httpStatusCode.bad_request,
	// 				message: `Old session manager (ID: ${oldSessionManagerId}) not found`,
	// 			});
	// 		}

	// 		const oldOrgId = oldSMUser.organization_id;

	// 		const getExtensionData = async (userId) => {
	// 			const user = getUserById(userId);
	// 			if (!user) return null;

	// 			const roles = (user.user_roles || []).map(r => r.title);
	// 			if (roles.includes(common.MENTOR_ROLE)) {
	// 				return mentorExtensionQueries.getMentorExtension(userId, ['organization_id']);
	// 			} else if (roles.includes(common.MENTEE_ROLE)) {
	// 				return menteeQueries.getMenteeExtension(userId, ['organization_id']);
	// 			}
	// 			return null;
	// 		};

	// 		const uniqueUserIdsForExtension = Array.from(new Set([
	// 			oldSessionManagerId,
	// 			newSessionManagerId,
	// 			orgAdminUserId,
	// 		]));

	// 		const extensionResults = await Promise.all(uniqueUserIdsForExtension.map(id => getExtensionData(id)));
	// 		const extensionMap = {};
	// 		uniqueUserIdsForExtension.forEach((id, idx) => extensionMap[id] = extensionResults[idx]);

	// 		const newSMPolicy = extensionMap[newSessionManagerId];
	// 		const orgAdminPolicy = extensionMap[orgAdminUserId];

	// 		if (!newSMPolicy || !newSMPolicy.organization_id) {
	// 			return responses.failureResponse({
	// 				statusCode: httpStatusCode.bad_request,
	// 				message: `New session manager (ID: ${newSessionManagerId}) has no organization_id in extension data`,
	// 			});
	// 		}

	// 		if (!orgAdminPolicy || !orgAdminPolicy.organization_id) {
	// 			return responses.failureResponse({
	// 				statusCode: httpStatusCode.bad_request,
	// 				message: `Org admin (ID: ${orgAdminUserId}) has no organization_id in extension data`,
	// 			});
	// 		}

	// 		const getUserRoleTitles = (user) => (user?.user_roles || []).map(r => r.title);

	// 		if (!getUserRoleTitles(newSMUser).includes(common.SESSION_MANAGER_ROLE)) {
	// 			return responses.failureResponse({
	// 				statusCode: httpStatusCode.bad_request,
	// 				message: `New session manager (ID: ${newSessionManagerId}) does not have required role: ${common.SESSION_MANAGER_ROLE}`,
	// 			});
	// 		}

	// 		if (!getUserRoleTitles(orgAdminUser).includes(common.ORG_ADMIN_ROLE)) {
	// 			return responses.failureResponse({
	// 				statusCode: httpStatusCode.bad_request,
	// 				message: 'Org admin must have ORG_ADMIN_ROLE in the same organization as old session manager.',
	// 			});
	// 		}

	// 		const isUserAllowedToAccessOrg = async (userId, targetOrgId) => {
	// 			const mentorExt = await mentorQueries.getMentorExtension(userId, ['organization_id']);
	// 			const menteeExt = await menteeQueries.getMenteeExtension(userId, ['organization_id']);

	// 			const policiesToCheck = [];
	// 			if (mentorExt?.organization_id) policiesToCheck.push(mentorExt.organization_id);
	// 			if (menteeExt?.organization_id) policiesToCheck.push(menteeExt.organization_id);

	// 			for (const orgId of policiesToCheck) {
	// 				const orgPolicy = await organisationExtensionQueries.findOne(
	// 					{ organization_id: orgId },
	// 					{ attributes: ['external_mentee_visibility_policy'] }
	// 				);

	// 				const visibilityPolicy = orgPolicy?.external_mentee_visibility_policy;
	// 				if (!visibilityPolicy) continue;

	// 				if (visibilityPolicy === common.CURRENT) {
	// 					if (orgId === targetOrgId) return true;
	// 				} else if (visibilityPolicy === common.ASSOCIATED) {

	// 					const mentor = await mentorQueries.getMentorExtension(
	// 						 userId,
	// 						{ attributes: ['visible_to_organizations', 'mentee_visibility'] }
	// 					)

	// 					if (
	// 						mentor &&
	// 						mentor.mentee_visibility !== 'CURRENT' &&
	// 						Array.isArray(mentor.visible_to_organizations) &&
	// 						mentor.visible_to_organizations.includes(targetOrgId)
	// 					) {
	// 						return true;
	// 					}
	// 				} else if (visibilityPolicy === common.ALL) {
	// 					return true;
	// 				}
	// 			}
	// 			return false;
	// 		};

	// 		const isNewSMAllowed = await isUserAllowedToAccessOrg(newSessionManagerId, oldOrgId);
	// 		if (!isNewSMAllowed) {
	// 			return responses.failureResponse({
	// 				statusCode: httpStatusCode.bad_request,
	// 				message: `New session manager (ID: ${newSessionManagerId}) does not have policy access to old session manager's organization`,
	// 			});
	// 		}

	// 		// Only check orgAdmin if it's a different user than newSessionManager
	// 		if (newSessionManagerId !== orgAdminUserId) {
	// 			const isOrgAdminAllowed = await isUserAllowedToAccessOrg(orgAdminUserId, oldOrgId);
	// 			if (!isOrgAdminAllowed) {
	// 				return responses.failureResponse({
	// 					statusCode: httpStatusCode.bad_request,
	// 					message: `Org admin (ID: ${orgAdminUserId}) does not have policy access to old session manager's organization`,
	// 				});
	// 			}
	// 		}

	// 		return true

	// 	} catch (error) {
	// 		return responses.failureResponse({
	// 			statusCode: httpStatusCode.bad_request,
	// 			message: `Session policy validation failed: ${error.message}`,
	// 			responseCode: 'CLIENT_ERROR',
	// 		});
	// 	}
	// }

	static async getConnectedMentors(menteeUserId, tenantCode) {
		try {
			const query = `
				SELECT DISTINCT user_id 
				FROM ${Connection.tableName} 
				WHERE friend_id = :menteeUserId 
				AND status = :acceptedStatus
				AND tenant_code = :tenantCode
			`

			const connections = await sequelize.query(query, {
				type: QueryTypes.SELECT,
				replacements: {
					menteeUserId,
					acceptedStatus: common.CONNECTIONS_STATUS.ACCEPTED,
					tenantCode,
				},
			})

			const mentorIds = connections.map((conn) => conn.user_id)

			if (mentorIds.length === 0) {
				return []
			}

			// Get mentor details for notification
			const mentors = (await mentorQueries.getMentorsByUserIds)
				? await mentorQueries.getMentorsByUserIds(
						mentorIds,
						{
							attributes: ['user_id', 'name', 'email'],
						},
						tenantCode
				  )
				: await userExtensionQueries.getUsersByUserIds(
						mentorIds,
						{
							attributes: ['user_id', 'name', 'email'],
						},
						tenantCode
				  )

			return mentors || []
		} catch (error) {
			console.error('Error getting connected mentors:', error)
			return []
		}
	}

	static async notifyMentorsAboutMenteeDeletion(mentors, menteeName, orgCodes, tenantCode) {
		return await NotificationHelper.sendGenericNotification({
			recipients: mentors,
			templateCode: process.env.MENTEE_DELETION_NOTIFICATION_EMAIL_TEMPLATE,
			orgCode: orgCodes,
			templateData: { menteeName },
			subjectData: { menteeName },
			tenantCode,
		})
	}

	static async getPrivateSessionsWithDeletedMentee(menteeUserId, tenantCode) {
		try {
			// Get private sessions where the deleted mentee was enrolled and session is in future
			const query = `
				SELECT DISTINCT s.id, s.title, s.mentor_id, s.start_date, s.end_date, s.type
				FROM ${Session.tableName} s
				INNER JOIN ${SessionAttendee.tableName} sa ON s.id = sa.session_id
				WHERE sa.mentee_id = :menteeUserId
				AND s.type = :privateType
				AND s.start_date > :currentTime
				AND s.deleted_at IS NULL
				AND s.tenant_code = :tenantCode
				AND sa.tenant_code = :tenantCode
			`

			const privateSessions = await sequelize.query(query, {
				type: QueryTypes.SELECT,
				replacements: {
					menteeUserId,
					privateType: common.SESSION_TYPE.PRIVATE,
					currentTime: Math.floor(Date.now() / 1000),
					tenantCode,
				},
			})

			return privateSessions || []
		} catch (error) {
			console.error('Error getting private sessions with deleted mentee:', error)
			return []
		}
	}

	static async notifyMentorAboutPrivateSessionCancellation(mentorId, sessionDetails, orgCodes, tenantCode) {
		try {
			const mentorDetails = await mentorQueries.getMentorExtension(
				mentorId,
				['name', 'email'],
				true,
				tenantCode // Use primary tenant for database query
			)

			const sessionDateTime = moment.unix(sessionDetails.start_date)

			return await NotificationHelper.sendGenericNotification({
				recipients: [mentorDetails],
				templateCode: process.env.PRIVATE_SESSION_CANCELLED_EMAIL_TEMPLATE,
				orgCode: orgCodes,
				templateData: {
					sessionName: sessionDetails.title,
					sessionDate: sessionDateTime.format('DD-MM-YYYY'),
					sessionTime: sessionDateTime.format('hh:mm A'),
				},
				subjectData: { sessionName: sessionDetails.title },
				tenantCode,
			})
		} catch (error) {
			console.error('Error notifying mentor about private session cancellation:', error)
			return false
		}
	}

	static async notifySessionManagerIfMenteeDeleted(userId, userInfo, result, tenantCode) {
		try {
			// Get defaults for combined notification codes
			const defaults = await getDefaults()
			const userOrgCode = userInfo.organization_code || ''
			const orgCodes = [userOrgCode, defaults.orgCode].filter(Boolean)

			// 1. Get upcoming private sessions where deleted mentee was enrolled
			const upcomingSessions = await sessionQueries.getUpcomingSessionsOfMentee(
				userId,
				common.SESSION_TYPE.PRIVATE,
				tenantCode
			)

			if (upcomingSessions.length > 0) {
				result.isSessionManagerNotified = await this.notifySessionManagersAboutMenteeDeletion(
					upcomingSessions,
					userInfo.name || 'User',
					orgCodes,
					tenantCode
				)
			} else {
				result.isSessionManagerNotified = true
			}
			return result
		} catch (error) {
			console.error('Error in notifySessionManagerIfMenteeDeleted:', error)
			result.isSessionManagerNotified = false
		}
	}

	static async handleMentorDeletion(mentorUserId, mentorInfo, result, tenantCode) {
		try {
			// Get defaults for combined notification codes
			const defaults = await getDefaults()
			const userOrgCode = mentorInfo.organization_code
			const orgCodes = [userOrgCode, defaults.orgCode].filter(Boolean)

			// 2. Handle session requests - auto-reject pending requests
			const pendingSessionRequests = await this.getPendingSessionRequestsForMentor(mentorUserId, tenantCode)

			if (pendingSessionRequests.length > 0) {
				result.isSessionRequestsRejected = await this.rejectSessionRequestsDueToMentorDeletion(
					pendingSessionRequests,
					orgCodes,
					tenantCode
				)
			} else {
				result.isSessionRequestsRejected = true
			}

			// 3. Get upcoming sessions for mentor - use user tenant for DB query
			const upcomingSessions = await sessionQueries.getUpcomingSessionsForMentor(mentorUserId, tenantCode)

			// 4. Notify session managers about sessions with deleted mentor
			if (upcomingSessions.length > 0) {
				result.isSessionManagerNotified = await this.notifySessionManagersAboutMentorDeletion(
					upcomingSessions,
					mentorInfo.name || 'Mentor',
					orgCodes,
					tenantCode
				)
			} else {
				result.isSessionManagerNotified = true
			}

			// 5. Handle sessions created by mentor - unenroll and notify attendees
			const removedSessionsDetail = await sessionQueries.removeAndReturnMentorSessions(mentorUserId, tenantCode)

			// Cache invalidation: Clear cache for removed sessions based on session id
			if (removedSessionsDetail && removedSessionsDetail.length > 0) {
				for (const session of removedSessionsDetail) {
					try {
						await cacheHelper.sessions.delete(tenantCode, session.id)
					} catch (cacheError) {
						console.error(`Cache deletion failed for session ${session.id}:`, cacheError)
					}
				}
			}

			result.isAttendeesNotified = await this.unenrollAndNotifySessionAttendees(
				removedSessionsDetail,
				orgCodes,
				tenantCode,
				userOrgCode
			)

			// 6. Update sessions where mentor was assigned (not created by mentor)
			result.isAssignedSessionsUpdated = await this.updateSessionsWithAssignedMentor(
				mentorUserId,
				userOrgCode,
				tenantCode,
				orgCodes,
				tenantCode
			)

			// 7. Remove mentor from DB
			result.mentorDetailsRemoved = await mentorQueries.removeMentorDetails(mentorUserId, tenantCode)

			// Cache invalidation: Clear mentor cache after removal
			try {
				await cacheHelper.mentor.delete(tenantCode, mentorUserId)
			} catch (cacheError) {
				console.error(`Cache deletion failed for mentor ${mentorUserId}:`, cacheError)
			}

			// 8. Mark created sessions as deleted
			if (upcomingSessions.length > 0) {
				const sessionIds = [...new Set(upcomingSessions.map((s) => s.id))]
				await sessionQueries.updateRecords(
					{ deleted_at: new Date() },
					{ where: { id: sessionIds, created_by: mentorUserId, tenant_code: tenantCode } }
				)

				// Cache invalidation: Clear session cache for deleted sessions
				for (const sessionId of sessionIds) {
					try {
						await cacheHelper.sessions.delete(tenantCode, sessionId)
					} catch (cacheError) {
						console.error(`Cache deletion failed for session ${sessionId}:`, cacheError)
					}
				}
			}
		} catch (error) {
			console.error('Error in handleMentorDeletion:', error)
			result.isMenteeNotifiedAboutMentorDeletion = false
			result.isSessionRequestsRejected = false
			result.isSessionManagerNotified = false
			result.isAssignedSessionsUpdated = false
			result.isAttendeesNotified = false
			result.mentorDetailsRemoved = 0
		}
	}

	static async getConnectedMentees(mentorUserId, tenantCode) {
		try {
			const query = `
				SELECT DISTINCT friend_id as user_id
				FROM ${Connection.tableName} 
				WHERE user_id = :mentorUserId 
				AND status = :acceptedStatus
				AND tenant_code = :tenantCode
			`

			const connections = await sequelize.query(query, {
				type: QueryTypes.SELECT,
				replacements: {
					mentorUserId,
					acceptedStatus: common.CONNECTIONS_STATUS.ACCEPTED,
					tenantCode,
				},
			})

			const menteeIds = connections.map((conn) => conn.user_id)

			if (menteeIds.length === 0) {
				return []
			}

			const mentees = await userExtensionQueries.getUsersByUserIds(
				menteeIds,
				{
					attributes: ['user_id', 'name', 'email'],
				},
				tenantCode
			)

			return mentees || []
		} catch (error) {
			console.error('Error getting connected mentees:', error)
			return []
		}
	}
	static async updateSessionsWithAssignedMentor(mentorUserId, userOrgCode, userTenantCode, orgCodes, tenantCode) {
		try {
			// Use user's tenant code for database queries to get exact sessions
			const sessionsToUpdate = await sessionQueries.getSessionsAssignedToMentor(mentorUserId, userTenantCode)
			if (sessionsToUpdate.length === 0) {
				return true
			}

			// Use combined codes for notifications (user + defaults)
			await this.notifyAttendeesAboutSessionDeletion(sessionsToUpdate, orgCodes, tenantCode)

			// Use user's tenant code for database updates
			const sessionIds = [...new Set(sessionsToUpdate.map((s) => s.id))]
			await sessionQueries.updateRecords(
				{ mentor_name: common.USER_NOT_FOUND, mentor_id: null },
				{ where: { id: sessionIds, tenant_code: userTenantCode } }
			)

			for (const sessionId of sessionIds) {
				try {
					await cacheHelper.sessions.delete(userTenantCode, sessionId)
				} catch (cacheError) {
					console.error(`Cache deletion failed for session ${sessionId}:`, cacheError)
				}
			}

			console.log(`Updated ${sessionIds.length} sessions with mentor removal`)
			return true
		} catch (error) {
			console.error('Error updating sessions with assigned mentor:', error)
			return false
		}
	}

	static async notifyMenteesAboutMentorDeletion(mentees, mentorName, orgCodes, tenantCode) {
		return await NotificationHelper.sendGenericNotification({
			recipients: mentees,
			templateCode: process.env.MENTOR_DELETION_NOTIFICATION_EMAIL_TEMPLATE,
			orgCode: orgCodes,
			templateData: { mentorName },
			subjectData: { mentorName },
			tenantCode,
		})
	}

	static async getPendingSessionRequestsForMentor(mentorUserId, tenantCode) {
		try {
			const pendingRequests = await RequestSession.findAll({
				where: {
					requestee_id: mentorUserId,
					status: common.CONNECTIONS_STATUS.REQUESTED,
					tenant_code: tenantCode,
				},
				raw: true,
			})

			return pendingRequests || []
		} catch (error) {
			console.error('Error getting pending session requests for mentor:', error)
			return []
		}
	}

	static async rejectSessionRequestsDueToMentorDeletion(sessionRequests, orgCodes, tenantCode) {
		try {
			for (const request of sessionRequests) {
				// Mark request as rejected
				await requestSessionQueries.rejectRequest(
					request.requestee_id,
					request.id,
					'Mentor no longer available',
					tenantCode
				)

				// Get mentee details for notification
				const menteeDetails = await userExtensionQueries.getUsersByUserIds(
					[request.requestor_id],
					{
						attributes: ['name', 'email'],
					},
					tenantCode
				)

				if (menteeDetails.length > 0) {
					// Send notification to requestor (mentee)
					await NotificationHelper.sendGenericNotification({
						recipients: menteeDetails,
						templateCode: process.env.SESSION_REQUEST_REJECTED_MENTOR_DELETION_EMAIL_TEMPLATE,
						orgCode: orgCodes,
						templateData: { sessionName: request.title },
						subjectData: { sessionName: request.title },
						tenantCode,
					})
				}
			}

			console.log(`Rejected ${sessionRequests.length} session requests due to mentor deletion`)
			return true
		} catch (error) {
			console.error('Error rejecting session requests due to mentor deletion:', error)
			return false
		}
	}

	static async notifySessionManagersAboutMentorDeletion(sessions, mentorName, orgCodes, tenantCode) {
		try {
			const templateCode = process.env.SESSION_MANAGER_MENTOR_DELETION_EMAIL_TEMPLATE
			if (!templateCode) {
				console.log('No email template configured for session manager mentor deletion notification')
				return true
			}

			// Group sessions by session manager
			const sessionsByManager = {}
			sessions.forEach((session) => {
				if (!sessionsByManager[session.created_by]) {
					sessionsByManager[session.created_by] = []
				}
				sessionsByManager[session.created_by].push(session)
			})

			const notificationPromises = Object.keys(sessionsByManager).map(async (managerId) => {
				const managerSessions = sessionsByManager[managerId]

				// Get session manager details
				const managerDetails = await userExtensionQueries.getUsersByUserIds(
					[managerId],
					{
						attributes: ['name', 'email'],
					},
					tenantCode
				)

				if (managerDetails.length > 0) {
					const sessionList = managerSessions
						.map((session) => {
							const sessionDateTime = moment.unix(session.start_date)
							return `<p>${session.title} – ${sessionDateTime.format('DD-MM-YYYY, hh:mm A')}</p>`
						})
						.join('\n')

					await NotificationHelper.sendGenericNotification({
						recipients: managerDetails,
						templateCode,
						orgCode: orgCodes,
						templateData: { mentorName, sessionList },
						subjectData: { mentorName },
						tenantCode,
					})
				}
			})

			await Promise.all(notificationPromises)
			console.log(`Notified session managers about mentor deletion for ${sessions.length} sessions`)
			return true
		} catch (error) {
			console.error('Error notifying session managers about mentor deletion:', error)
			return false
		}
	}

	static async notifySessionManagersAboutMenteeDeletion(sessions, menteeName, orgCodes, tenantCode) {
		try {
			const templateCode = process.env.SESSION_MANAGER_MENTEE_DELETION_EMAIL_TEMPLATE
			if (!templateCode) {
				console.log('No email template configured for session manager mentee deletion notification')
				return true
			}

			// Group sessions by session manager
			const sessionsByManager = {}
			sessions.forEach((session) => {
				if (!sessionsByManager[session.created_by]) {
					sessionsByManager[session.created_by] = []
				}
				sessionsByManager[session.created_by].push(session)
			})

			const notificationPromises = Object.keys(sessionsByManager).map(async (managerId) => {
				const managerSessions = sessionsByManager[managerId]

				// Get session manager details using user's tenant code for DB query
				const managerDetails = await userExtensionQueries.getUsersByUserIds(
					[managerId],
					{
						attributes: ['name', 'email'],
					},
					tenantCode
				)

				if (managerDetails.length > 0) {
					const sessionList = managerSessions
						.map((session) => {
							const sessionDateTime = moment.unix(session.start_date)
							return `<p>${session.title} – ${sessionDateTime.format('DD-MM-YYYY, hh:mm A')}</p>`
						})
						.join('\n')

					await NotificationHelper.sendGenericNotification({
						recipients: managerDetails,
						templateCode,
						orgCode: orgCodes,
						templateData: { menteeName: menteeName, sessionList: sessionList },
						subjectData: { menteeName: menteeName },
						tenantCode,
					})
				}
			})

			await Promise.all(notificationPromises)
			console.log(`Notified session managers about mentee deletion for ${sessions.length} sessions`)
			return true
		} catch (error) {
			console.error('Error notifying session managers about mentee deletion:', error)
			return false
		}
	}

	static async notifyAttendeesAboutSessionDeletion(sessions, orgCodes, tenantCode) {
		try {
			const templateCode = process.env.SESSION_DELETED_MENTOR_DELETION_EMAIL_TEMPLATE
			if (!templateCode) {
				console.log('No email template configured for session deletion due to mentor deletion')
				return
			}

			// Use first organization and tenant codes for database queries
			const orgCode = Array.isArray(orgCodes) ? orgCodes[0] : orgCodes

			// Group sessions by attendee
			const sessionsByAttendee = {}
			sessions.forEach((session) => {
				if (!sessionsByAttendee[session.mentee_id]) {
					sessionsByAttendee[session.mentee_id] = []
				}
				sessionsByAttendee[session.mentee_id].push(session)
			})

			const notificationPromises = Object.keys(sessionsByAttendee).map(async (attendeeId) => {
				const attendeeSessions = sessionsByAttendee[attendeeId]

				const attendeeDetails = await userExtensionQueries.getUsersByUserIds(
					[attendeeId],
					{
						attributes: ['name', 'email'],
					},
					tenantCode
				)

				if (attendeeDetails.length > 0) {
					for (const session of attendeeSessions) {
						await NotificationHelper.sendGenericNotification({
							recipients: attendeeDetails,
							templateCode,
							orgCode: orgCodes,
							templateData: { sessionName: session.title },
							subjectData: { sessionName: session.title },
							tenantCode,
						})
					}
				}
			})

			await Promise.all(notificationPromises)
			console.log(`Notified attendees about session deletions due to mentor deletion`)
			return true
		} catch (error) {
			console.error('Error notifying attendees about session deletion:', error)
			return false
		}
	}

	/**
	 * Cache Administration Methods
	 */

	/**
	 * Get cache statistics and monitoring information
	 * @method
	 * @name getCacheStatistics
	 * @param {String} tenantCode - Tenant code for stats
	 * @param {String} organizationId - Organization ID for stats
	 * @returns {JSON} - Cache statistics response
	 */
	static async getCacheStatistics(tenantCode, organizationId) {
		try {
			const redisClient = cacheHelper._internal.getRedisClient()
			if (!redisClient) {
				return responses.failureResponse({
					statusCode: httpStatusCode.service_unavailable,
					message: 'CACHE_SERVICE_UNAVAILABLE',
					responseCode: 'SERVICE_ERROR',
				})
			}

			// Get Redis info
			const redisInfo = await redisClient.info()
			const redisMemory = await redisClient.info('memory')
			const keyspaceInfo = await redisClient.info('keyspace')

			// Get key counts by namespace for the tenant
			// Extract namespaces from cacheHelper instead of hardcoding
			const namespaces = Object.keys(cacheHelper).filter(
				(key) =>
					typeof cacheHelper[key] === 'object' &&
					cacheHelper[key] !== null &&
					typeof cacheHelper[key].get === 'function'
			)

			const namespaceCounts = {}
			for (const namespace of namespaces) {
				try {
					const pattern = `tenant:${tenantCode}:org:${organizationId}:${namespace}:*`
					const keys = await redisClient.scan(0, 'MATCH', pattern, 'COUNT', 1000)
					namespaceCounts[namespace] = Array.isArray(keys[1]) ? keys[1].length : 0
				} catch (error) {
					namespaceCounts[namespace] = 0
				}
			}

			// Parse Redis info
			const memoryUsed = this.parseRedisInfo(redisMemory, 'used_memory_human')
			const memoryPeak = this.parseRedisInfo(redisMemory, 'used_memory_peak_human')
			const connectedClients = this.parseRedisInfo(redisInfo, 'connected_clients')
			const totalCommands = this.parseRedisInfo(redisInfo, 'total_commands_processed')
			const keyspaceHits = this.parseRedisInfo(redisInfo, 'keyspace_hits')
			const keyspaceMisses = this.parseRedisInfo(redisInfo, 'keyspace_misses')

			const hitRate =
				keyspaceHits + keyspaceMisses > 0
					? ((keyspaceHits / (keyspaceHits + keyspaceMisses)) * 100).toFixed(2)
					: '0'

			const statistics = {
				cacheEnabled: cacheHelper._internal.ENABLE_CACHE,
				redisStats: {
					memoryUsed,
					memoryPeak,
					connectedClients,
					totalCommands,
					keyspaceHits,
					keyspaceMisses,
					hitRate: `${hitRate}%`,
				},
				tenantStats: {
					tenantCode,
					organizationId,
					namespaceCounts,
					totalKeys: Object.values(namespaceCounts).reduce((sum, count) => sum + count, 0),
				},
				configuration: {
					shards: cacheHelper._internal.SHARDS,
					batchSize: cacheHelper._internal.BATCH,
					cacheConfig: cacheHelper._internal.CACHE_CONFIG,
				},
				timestamp: new Date().toISOString(),
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'CACHE_STATS_FETCHED_SUCCESSFULLY',
				result: statistics,
			})
		} catch (error) {
			console.error('Error getting cache statistics:', error)
			return responses.failureResponse({
				statusCode: httpStatusCode.internal_server_error,
				message: 'CACHE_STATS_FETCH_FAILED',
				responseCode: 'SERVER_ERROR',
				result: { error: error.message },
			})
		}
	}

	/**
	 * Clear cache for specific namespace, tenant, or organization
	 * @method
	 * @name clearCache
	 * @param {Object} options - Clear cache options
	 * @returns {JSON} - Cache clear response
	 */
	static async clearCache({ namespace, tenantCode, orgId, adminTenantCode, adminOrgId }) {
		try {
			const redisClient = cacheHelper._internal.getRedisClient()
			if (!redisClient) {
				return responses.failureResponse({
					statusCode: httpStatusCode.service_unavailable,
					message: 'CACHE_SERVICE_UNAVAILABLE',
					responseCode: 'SERVICE_ERROR',
				})
			}

			let clearedKeys = 0
			let patterns = []

			if (namespace && namespace !== 'all') {
				// Clear specific namespace
				if (orgId && orgId !== 'all') {
					patterns.push(`tenant:${tenantCode}:org:${orgId}:${namespace}:*`)
				} else {
					patterns.push(`tenant:${tenantCode}:*:${namespace}:*`)
				}
			} else if (orgId && orgId !== 'all') {
				// Clear all cache for specific org
				patterns.push(`tenant:${tenantCode}:org:${orgId}:*`)
			} else {
				// Clear all cache for tenant
				patterns.push(`tenant:${tenantCode}:*`)
			}

			// Execute cache clearing
			for (const pattern of patterns) {
				const keys = await this.scanKeys(redisClient, pattern)
				if (keys.length > 0) {
					await redisClient.del(...keys)
					clearedKeys += keys.length
				}
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'CACHE_CLEARED_SUCCESSFULLY',
				result: {
					clearedKeys,
					patterns,
					tenantCode,
					orgId,
					namespace,
					timestamp: new Date().toISOString(),
				},
			})
		} catch (error) {
			console.error('Error clearing cache:', error)
			return responses.failureResponse({
				statusCode: httpStatusCode.internal_server_error,
				message: 'CACHE_CLEAR_FAILED',
				responseCode: 'SERVER_ERROR',
				result: { error: error.message },
			})
		}
	}

	/**
	 * Warm up cache for tenant/organization
	 * @method
	 * @name warmUpCache
	 * @param {Object} options - Warm up options
	 * @returns {JSON} - Cache warm up response
	 */
	static async warmUpCache({ tenantCode, orgCode, adminTenantCode, adminOrgCode }) {
		try {
			const warmupResults = {
				entityTypes: 0,
				organizations: 0,
				platformConfig: 0,
				permissions: 0,
				forms: 0,
			}

			// Warm up EntityTypes cache
			try {
				await entityTypeHelper.warmUpEntityTypesCache(tenantCode, orgCode)
				warmupResults.entityTypes = 1
			} catch (error) {
				console.error('EntityTypes cache warmup failed:', error)
			}

			// Warm up Organizations cache
			try {
				const orgData = await orgQueries.findOne({ organization_code: orgCode }, tenantCode)
				if (orgData) {
					await cacheHelper.organizations.set(tenantCode, orgCode, orgData.organization_id, orgData)
					warmupResults.organizations = 1
				}
			} catch (error) {
				console.error('Organizations cache warmup failed:', error)
			}

			// Warm up Platform Config cache
			try {
				const configData = await formQueries.findOne({ code: 'platformConfig' }, tenantCode)
				if (configData) {
					await cacheHelper.platformConfig.set(tenantCode, orgCode, configData)
					warmupResults.platformConfig = 1
				}
			} catch (error) {
				console.error('Platform Config cache warmup failed:', error)
			}

			// Warm up Permissions cache
			try {
				// Get all distinct roles from permissions table instead of hardcoding
				const allPermissions = await permissionsQueries.findAllPermissions({})
				const uniqueRoles = [...new Set(allPermissions.map((perm) => perm.role))].filter(Boolean)

				for (const role of uniqueRoles) {
					const perms = await permissionsQueries.findAll({ role }, tenantCode)
					if (perms && perms.length > 0) {
						await cacheHelper.permissions.set(role, perms)
						warmupResults.permissions++
					}
				}
			} catch (error) {
				console.error('Permissions cache warmup failed:', error)
			}

			// Warm up Forms cache (get all forms dynamically)
			try {
				// Get all forms from database instead of hardcoding specific forms
				const allForms = await formQueries.findFormsByFilter({}, tenantCode)

				for (const form of allForms) {
					if (form.type && form.sub_type) {
						await cacheHelper.forms.set(tenantCode, orgCode, form.type, form.sub_type, form)
						warmupResults.forms++
					}
				}
			} catch (error) {
				console.error('Forms cache warmup failed:', error)
			}

			const totalWarmedUp = Object.values(warmupResults).reduce((sum, count) => sum + count, 0)

			console.log(`💾 Cache warmup completed for tenant:${tenantCode}, org:${orgCode} - ${totalWarmedUp} items`)

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'CACHE_WARMED_UP_SUCCESSFULLY',
				result: {
					tenantCode,
					orgCode,
					warmupResults,
					totalWarmedUp,
					timestamp: new Date().toISOString(),
				},
			})
		} catch (error) {
			console.error('Error warming up cache:', error)
			return responses.failureResponse({
				statusCode: httpStatusCode.internal_server_error,
				message: 'CACHE_WARMUP_FAILED',
				responseCode: 'SERVER_ERROR',
				result: { error: error.message },
			})
		}
	}

	/**
	 * Get cache health and configuration
	 * @method
	 * @name getCacheHealth
	 * @returns {JSON} - Cache health response
	 */
	static async getCacheHealth() {
		try {
			const redisClient = cacheHelper._internal.getRedisClient()
			const health = {
				cacheEnabled: cacheHelper._internal.ENABLE_CACHE,
				redisConnected: false,
				redisVersion: null,
				uptime: null,
				configuration: {
					shards: cacheHelper._internal.SHARDS,
					batchSize: cacheHelper._internal.BATCH,
					enableCache: cacheHelper._internal.ENABLE_CACHE,
					cacheConfig: cacheHelper._internal.CACHE_CONFIG,
				},
				namespaces: {},
				status: 'unhealthy',
			}

			if (redisClient) {
				try {
					const redisInfo = await redisClient.info()
					const redisVersion = this.parseRedisInfo(redisInfo, 'redis_version')
					const uptime = this.parseRedisInfo(redisInfo, 'uptime_in_seconds')

					health.redisConnected = true
					health.redisVersion = redisVersion
					health.uptime = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
					health.status = 'healthy'

					// Check namespace configurations
					const namespaceConfig = cacheHelper._internal.CACHE_CONFIG.namespaces || {}
					Object.keys(namespaceConfig).forEach((ns) => {
						health.namespaces[ns] = {
							enabled: namespaceConfig[ns].enabled !== false,
							defaultTtl: namespaceConfig[ns].defaultTtl,
							useInternal: namespaceConfig[ns].useInternal,
						}
					})
				} catch (redisError) {
					console.error('Redis health check failed:', redisError)
					health.status = 'redis_error'
				}
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'CACHE_HEALTH_CHECK_COMPLETED',
				result: {
					...health,
					timestamp: new Date().toISOString(),
				},
			})
		} catch (error) {
			console.error('Error checking cache health:', error)
			return responses.failureResponse({
				statusCode: httpStatusCode.internal_server_error,
				message: 'CACHE_HEALTH_CHECK_FAILED',
				responseCode: 'SERVER_ERROR',
				result: { error: error.message },
			})
		}
	}

	/**
	 * Helper method to scan Redis keys by pattern
	 * @private
	 */
	static async scanKeys(redisClient, pattern) {
		const keys = []
		let cursor = '0'

		do {
			const result = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 1000)
			cursor = result[0]
			if (result[1] && result[1].length > 0) {
				keys.push(...result[1])
			}
		} while (cursor !== '0')

		return keys
	}

	/**
	 * Helper method to parse Redis info strings
	 * @private
	 */
	static parseRedisInfo(infoString, key) {
		const lines = infoString.split('\r\n')
		const line = lines.find((l) => l.startsWith(`${key}:`))
		return line ? line.split(':')[1] : '0'
	}
}
