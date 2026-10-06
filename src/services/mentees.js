// Dependencies
const userRequests = require('@requests/user')
const common = require('@constants/common')
const httpStatusCode = require('@generics/http-status')
const feedbackHelper = require('./feedback')
const utils = require('@generics/utils')
const { UniqueConstraintError } = require('sequelize')
const menteeQueries = require('@database/queries/userExtension')
const sessionAttendeesQueries = require('@database/queries/sessionAttendees')
const sessionQueries = require('@database/queries/sessions')
const _ = require('lodash')
const entityTypeCache = require('@helpers/entityTypeCache')
const bigBlueButtonService = require('./bigBlueButton')
const organisationExtensionQueries = require('@database/queries/organisationExtension')
const orgAdminService = require('@services/org-admin')
const mentorQueries = require('@database/queries/mentorExtension')
const { getDefaults } = require('@helpers/getDefaultOrgId')
const { Op } = require('sequelize')
const { removeDefaultOrgEntityTypes } = require('@generics/utils')
const entityTypeService = require('@services/entity-type')
const { getEnrolledMentees } = require('@helpers/getEnrolledMentees')
const responses = require('@helpers/responses')
const permissions = require('@helpers/getPermissions')
const { buildSearchFilter } = require('@helpers/search')
const { defaultRulesFilter, validateDefaultRulesFilter } = require('@helpers/defaultRules')

const defaultSearchConfig = require('@configs/search.json')
const cacheHelper = require('@generics/cacheHelper')
const emailEncryption = require('@utils/emailEncryption')
const communicationHelper = require('@helpers/communications')
const { checkIfUserIsAccessible } = require('@helpers/saasUserAccessibility')
const connectionQueries = require('@database/queries/connection')
const getOrgIdAndEntityTypes = require('@helpers/getOrgIdAndEntityTypewithEntitiesBasedOnPolicy')
const searchConfig = require('@root/config.json')
const getOrganizationHelper = require('@helpers/getOrganizationList')

module.exports = class MenteesHelper {
	/**
	 * Profile.
	 * @method
	 * @name profile
	 * @param {String} userId - user id.
	 * @param {String} organizationId - organization id.
	 * @param {String} roles - user roles.
	 * @returns {JSON} - profile details
	 */
	static async read(id, organizationCode, roles, tenantCode) {
		// Try to get complete profile from cache first (only when false)
		const cachedProfile = await cacheHelper.mentee.getCacheOnly(tenantCode, id)
		// If we have cached data, update image URL and return response
		if (cachedProfile) {
			// Always generate fresh downloadable URL for image (cached URLs expire)
			if (cachedProfile.image) {
				try {
					cachedProfile.image = await utils.getDownloadableUrl(cachedProfile.image)
				} catch (error) {
					console.error(`Failed to get downloadable URL for cached profile image:`, error)
					cachedProfile.image = null
				}
			}

			if (cachedProfile?.meta?.communications_user_id) {
				try {
					const chat = await communicationHelper.login(id, tenantCode)
					cachedProfile.meta = {
						...cachedProfile.meta,
						chat,
					}
				} catch (error) {
					console.error('Failed to log in to communication service:', error)
				}
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'PROFILE_FETCHED_SUCCESSFULLY',
				result: cachedProfile,
			})
		}

		const menteeDetails = await userRequests.getUserDetails(id, tenantCode)
		const mentee = menteeDetails.data.result

		if (!mentee) {
			return responses.failureResponse({
				message: 'MENTEE_NOT_FOUND',
				statusCode: httpStatusCode.bad_request,
				responseCode: 'CLIENT_ERROR',
			})
		}

		delete mentee.user_id
		const visibleToOrganizations = mentee.visible_to_organizations
		delete mentee.visible_to_organizations

		const defaults = await getDefaults()
		if (!defaults.orgCode)
			return responses.failureResponse({
				message: 'DEFAULT_ORG_CODE_NOT_SET',
				statusCode: httpStatusCode.bad_request,
				responseCode: 'CLIENT_ERROR',
			})

		if (!defaults.tenantCode)
			return responses.failureResponse({
				message: 'DEFAULT_ORG_CODE_NOT_SET',
				statusCode: httpStatusCode.bad_request,
				responseCode: 'CLIENT_ERROR',
			})
		const userExtensionsModelName = await menteeQueries.getModelName()

		let entityTypes = await entityTypeCache.getEntityTypesAndEntitiesForModel(
			userExtensionsModelName,
			tenantCode,
			organizationCode
		)
		if (entityTypes instanceof Error) {
			throw entityTypes
		}

		const validationData = removeDefaultOrgEntityTypes(entityTypes, organizationCode)

		//validationData = utils.removeParentEntityTypes(JSON.parse(JSON.stringify(validationData)))

		let processDbResponse = utils.processDbResponse(mentee, validationData)

		// Try to get display properties from cache (with tenant/org fallback)
		let displayProperties = await cacheHelper.displayProperties.get(tenantCode, organizationCode)

		if (!displayProperties) {
			// Build display properties from entity types
			const sortedEntityType = await utils.sortData(validationData, 'meta.sequence')
			displayProperties = [
				{
					key: 'organization',
					label: 'Organization',
					visible: true,
					visibility: 'main',
					sequence: 1,
				},
			]
			for (const entityType of sortedEntityType) {
				displayProperties.push({ key: entityType.value, ...entityType.meta })
			}

			// Cache at both org and tenant levels for better hit rates
			try {
				await cacheHelper.displayProperties.set(tenantCode, organizationCode, displayProperties)
			} catch (cacheError) {
				console.error(`❌ Failed to cache display properties:`, cacheError)
			}
		}

		const menteePermissions = await permissions.getPermissions(roles, tenantCode, organizationCode)
		if (!Array.isArray(menteeDetails.data.result.permissions)) {
			menteeDetails.data.result.permissions = []
		}

		// Check if menteePermissions is an array (success) or response object (error)
		if (Array.isArray(menteePermissions)) {
			menteeDetails.data.result.permissions.push(...menteePermissions)
		} else {
			// It's the error response object, extract the permissions array
			menteeDetails.data.result.permissions.push(...(menteePermissions.result?.permissions || []))
		}

		const profileMandatoryFields = await utils.validateProfileData(processDbResponse, validationData)

		let communications = null

		if (mentee?.meta?.communications_user_id) {
			try {
				const chat = await communicationHelper.login(id, tenantCode)
				communications = chat
			} catch (error) {
				console.error('Failed to log in to communication service:', error)
			}
		}

		processDbResponse.meta = {
			...processDbResponse.meta,
			communications,
		}

		// Add missing computed fields to processDbResponse
		processDbResponse.profile_mandatory_fields = profileMandatoryFields

		// Add organization object - try cache first, fallback to database
		let orgDetails = null
		// Try to get from cache if we have organization_id
		if (processDbResponse.organization_id) {
			orgDetails = await cacheHelper.organizations.get(
				tenantCode,
				organizationCode,
				processDbResponse.organization_id
			)
		}

		// Fallback to database if cache miss or error
		if (!orgDetails) {
			orgDetails = await organisationExtensionQueries.findOne(
				{ organization_code: organizationCode },
				tenantCode,
				{ attributes: ['name', 'organization_code', 'organization_id'] }
			)
		}

		processDbResponse.organization = {
			id: orgDetails.organization_code,
			name: orgDetails.name,
		}

		// Add sessions_attended (both mentees and mentors can attend sessions)
		const totalSessionsAttendedRead = await sessionAttendeesQueries.countEnrolledSessions(id, tenantCode)
		processDbResponse.sessions_attended = totalSessionsAttendedRead

		// Add sessions_hosted for mentors
		if (mentee.is_mentor) {
			const totalSessionHosted = await sessionQueries.countHostedSessions(id, tenantCode)
			processDbResponse.sessions_hosted = totalSessionHosted
		}

		// Add is_connected (false for own profile read)
		processDbResponse.is_connected = false

		// Remove sensitive fields from menteeDetails
		const sanitizedMenteeData = utils.deleteProperties(menteeDetails.data.result, ['phone'])

		// Construct the final profile response (INCLUDE sessions_attended for read endpoint)
		const finalProfile = {
			user_id: id, // Add user_id to match mentor read response
			...sanitizedMenteeData,
			...processDbResponse,
			visible_to_organizations: visibleToOrganizations, // Add to match mentor read
			settings: mentee.settings, // Add settings to match mentor read
			displayProperties,
		}

		// Cache the complete profile response
		try {
			const cacheCopy = { ...finalProfile }
			delete cacheCopy.image
			delete cacheCopy.is_connected
			delete cacheCopy.connection_details
			if (cacheCopy.meta) {
				cacheCopy.meta = { ...cacheCopy.meta }
				delete cacheCopy.meta.communications
			}

			await cacheHelper.mentee.set(tenantCode, id, cacheCopy)
		} catch (cacheError) {
			console.error(`❌ Failed to cache mentee profile ${id}:`, cacheError)
		}

		return responses.successResponse({
			statusCode: httpStatusCode.ok,
			message: 'PROFILE_FTECHED_SUCCESSFULLY',
			result: finalProfile,
		})
	}

	/**
	 * Sessions list. Includes upcoming and enrolled sessions.
	 * @method
	 * @name sessions
	 * @param {String} userId - user id.
	 * @param {Boolean} enrolledSessions - true/false.
	 * @param {Number} page - page No.
	 * @param {Number} limit - page limit.
	 * @param {String} search - search field.
	 * @returns {JSON} - List of sessions
	 */

	static async sessions(userId, page, limit, search = '', tenantCode) {
		try {
			/** Upcoming user's enrolled sessions {My sessions}*/
			/* Fetch sessions if it is not expired or if expired then either status is live or if mentor 
				delays in starting session then status will remain published for that particular interval so fetch that also */

			/* TODO: Need to write cron job that will change the status of expired sessions from published to cancelled if not hosted by mentor */
			const sessions = await this.getMySessions(page, limit, search, userId, null, null, tenantCode)

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'SESSION_FETCHED_SUCCESSFULLY',
				result: { data: sessions.rows, count: sessions.count },
				tenantCode: tenantCode,
			})
		} catch (error) {
			throw error
		}
	}

	/**
	 * Mentees reports.
	 * @method
	 * @name reports
	 * @param {String} userId - user id.
	 * @param {String} filterType - MONTHLY/WEEKLY/QUARTERLY.
	 * @returns {JSON} - Mentees reports
	 */

	static async reports(userId, filterType, organizationId, tenantCode) {
		try {
			let filterStartDate, filterEndDate

			switch (filterType) {
				case 'MONTHLY':
					;[filterStartDate, filterEndDate] = utils.getCurrentMonthRange()
					break
				case 'WEEKLY':
					;[filterStartDate, filterEndDate] = utils.getCurrentWeekRange()
					break
				case 'QUARTERLY':
					;[filterStartDate, filterEndDate] = utils.getCurrentQuarterRange()
					break
				default:
					throw new Error('Invalid filterType')
			}

			const totalSessionsEnrolled = await sessionAttendeesQueries.getEnrolledSessionsCountInDateRange(
				filterStartDate.toISOString(),
				filterEndDate.toISOString(),
				userId,
				tenantCode
			)

			const totalSessionsAttended = await sessionAttendeesQueries.getAttendedSessionsCountInDateRange(
				filterStartDate.toISOString(),
				filterEndDate.toISOString(),
				userId,
				tenantCode
			)

			const result = {
				total_session_enrolled: totalSessionsEnrolled,
				total_session_attended: totalSessionsAttended,
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'MENTEES_REPORT_FETCHED_SUCCESSFULLY',
				result,
			})
		} catch (error) {
			throw error
		}
	}

	/**
	 * Mentees homeFeed.
	 * @method
	 * @name homeFeed
	 * @param {String} userId - user id.
	 * @param {Boolean} isAMentor - true/false.
	 * @returns {JSON} - Mentees homeFeed.
	 */

	static async homeFeed(
		userId,
		isAMentor,
		page,
		limit,
		search,
		queryParams,
		roles,
		organizationCode,
		start_date,
		end_date,
		tenantCode
	) {
		try {
			/* All Sessions */

			let result = {}

			let scope = ['all', 'my']
			if (queryParams.sessionScope) {
				scope = queryParams.sessionScope.split(',').map((s) => s.trim().toLowerCase())
				delete queryParams.sessionScope
			}
			let errors = []
			if (scope.includes('all')) {
				let allSessions = await this.getAllSessions(
					page,
					limit,
					search,
					userId,
					queryParams,
					isAMentor,
					'',
					roles,
					organizationCode,
					tenantCode
				)

				if (allSessions.error && allSessions.error.missingField) {
					errors.push({ scope: 'all', message: 'PROFILE_NOT_UPDATED' })
				} else {
					result.all_sessions = allSessions.rows
					result.allSessions_count = allSessions.count
				}
			}

			if (scope.includes('my')) {
				try {
					let mySessions = await this.getMySessions(
						page,
						limit,
						search,
						userId,
						start_date,
						end_date,
						tenantCode
					)
					result.my_sessions = mySessions.rows
					result.my_sessions_count = mySessions.count
				} catch (error) {
					// Handle error similarly to getAllSessions or add to errors array
					console.error('Error fetching my sessions:', error)
				}
			}

			const feedbackData = await feedbackHelper.pending(userId, isAMentor, organizationCode, tenantCode)

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'SESSION_FETCHED_SUCCESSFULLY',
				result: result,
				error: errors,
				meta: {
					type: 'feedback',
					data: feedbackData.result,
				},
			})
		} catch (error) {
			throw error
		}
	}

	/**
	 * Join session as Mentees.
	 * @method
	 * @name joinSession
	 * @param {String} sessionId - session id.
	 * @param {String} token - Mentees token.
	 * @returns {JSON} - Mentees join session link.
	 */

	static async joinSession(sessionId, userId, tenantCode) {
		try {
			const mentee = await cacheHelper.mentee.get(tenantCode, userId)
			if (!mentee) {
				return responses.failureResponse({
					message: 'USER_NOT_FOUND',
					statusCode: httpStatusCode.not_found,
					responseCode: 'CLIENT_ERROR',
				})
			}

			// Optimized: Single query with JOIN to get session and attendee data together
			let sessionWithAttendee
			let sessionData = await cacheHelper.sessions.get(tenantCode, sessionId)
			if (sessionData) {
				sessionWithAttendee = sessionData.mentees?.find((mentee) => String(mentee.id) === String(userId))
				if (sessionWithAttendee) {
					sessionWithAttendee = {
						...sessionWithAttendee,
						id: sessionWithAttendee.id, // Keep id for DB updates
						attendee_id: sessionWithAttendee.id,
						enrolled_type: sessionWithAttendee.type,
						attendee_meeting_info: sessionWithAttendee.meeting_info ?? sessionData.meeting_info,
					}
				}
				// If mentee_password is missing from cache, fetch from database
				if (!sessionData.mentee_password) {
					const fullSessionData = await sessionQueries.findOne({ id: sessionId }, tenantCode)
					if (fullSessionData?.mentee_password) {
						sessionData.mentee_password = fullSessionData.mentee_password
					}
				}
			} else {
				// Cache miss: fetch session with attendee in a single query
				sessionWithAttendee = await sessionQueries.findSessionWithAttendee(
					sessionId,
					mentee.user_id,
					tenantCode
				)

				if (sessionWithAttendee) {
					// Use the same object as sessionData since it already contains full session fields
					// (including mentee_password, meeting_info, etc.) and attendee fields via attendeeData DTO
					sessionData = { ...sessionWithAttendee }
				} else {
					sessionData = null
				}
			}

			if (!sessionWithAttendee) {
				return responses.failureResponse({
					message: 'SESSION_NOT_FOUND',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			// Normalize status that may be stored as processed {value, label} object in cache
			sessionData.status = sessionData.status?.value ?? sessionData.status

			const sessionAttendeeExist = sessionWithAttendee.attendee_id
				? {
						id: sessionWithAttendee.attendee_id,
						type: sessionWithAttendee.enrolled_type,
						meeting_info: sessionWithAttendee.attendee_meeting_info,
						joined_at: sessionWithAttendee.joined_at,
						mentee_id: sessionWithAttendee.mentee_id,
				  }
				: null

			if (sessionData.status == 'COMPLETED') {
				return responses.failureResponse({
					message: 'SESSION_ENDED',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			if (sessionData.status !== 'LIVE') {
				return responses.failureResponse({
					message: 'JOIN_ONLY_LIVE_SESSION',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			if (!sessionAttendeeExist) {
				return responses.failureResponse({
					message: 'USER_NOT_ENROLLED',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}
			let meetingInfo
			if (sessionData?.meeting_info?.value !== common.BBB_VALUE) {
				meetingInfo = sessionData.meeting_info

				await sessionAttendeesQueries.updateOne(
					{
						id: sessionWithAttendee.attendee_id,
					},
					{
						meeting_info: meetingInfo,
						joined_at: utils.utcFormat(),
					},
					tenantCode
				)
				return responses.successResponse({
					statusCode: httpStatusCode.ok,
					message: 'SESSION_START_LINK',
					result: meetingInfo,
				})
			}

			if (sessionAttendeeExist?.meeting_info?.link) {
				// Existing BBB attendee link present in DB – just reuse it
				meetingInfo = sessionAttendeeExist.meeting_info
			} else {
				// No existing link – generate a fresh one from BBB and store it
				if (!sessionData.mentee_password) {
					return responses.failureResponse({
						message: 'MENTEE_PASSWORD_NOT_FOUND',
						statusCode: httpStatusCode.bad_request,
						responseCode: 'CLIENT_ERROR',
					})
				}

				const menteeName = mentee.name || 'Attendee'
				const attendeeLink = await bigBlueButtonService.joinMeetingAsAttendee(
					sessionId,
					menteeName,
					sessionData.mentee_password
				)
				meetingInfo = {
					value: common.BBB_VALUE,
					platform: common.BBB_PLATFORM,
					link: attendeeLink,
				}
				await sessionAttendeesQueries.updateOne(
					{
						id: sessionWithAttendee.attendee_id,
					},
					{
						meeting_info: meetingInfo,
						joined_at: utils.utcFormat(),
					},
					tenantCode
				)
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'SESSION_START_LINK',
				result: meetingInfo,
			})
		} catch (error) {
			return error
		}
	}

	/**
	 * Get all upcoming unenrolled session.
	 * @method
	 * @name getAllSessions
	 * @param {Number} page - page No.
	 * @param {Number} limit - page limit.
	 * @param {String} search - search session.
	 * @param {String} userId - user id.
	 * @returns {JSON} - List of all sessions
	 */

	static async getAllSessions(
		page,
		limit,
		search,
		userId,
		queryParams,
		isAMentor,
		searchOn,
		roles,
		organizationCode,
		tenantCode
	) {
		let additionalProjectionString = ''

		// check for fields query
		if (queryParams.fields && queryParams.fields !== '') {
			additionalProjectionString = queryParams.fields
			delete queryParams.fields
		}
		let query = utils.processQueryParametersWithExclusions(queryParams)
		const sessionModelName = await sessionQueries.getModelName()

		const defaults = await getDefaults()

		if (!defaults.tenantCode)
			return responses.failureResponse({
				message: 'DEFAULT_ORG_CODE_NOT_SET',
				statusCode: httpStatusCode.bad_request,
				responseCode: 'CLIENT_ERROR',
			})

		if (!defaults.orgCode)
			return responses.failureResponse({
				message: 'DEFAULT_ORG_CODE_NOT_SET',
				statusCode: httpStatusCode.bad_request,
				responseCode: 'CLIENT_ERROR',
			})

		let validationData = await entityTypeCache.getEntityTypesAndEntitiesForModel(
			sessionModelName,
			tenantCode,
			organizationCode
		)

		let filteredQuery = utils.validateAndBuildFilters(query, validationData, sessionModelName)

		// Create saas filter for view query
		const saasFilter = await this.filterSessionsBasedOnSaasPolicy(userId, isAMentor, tenantCode, organizationCode)

		let search_config = defaultSearchConfig
		if (searchConfig.search) {
			search_config = { search: searchConfig.search }
		}
		const searchFilter = await buildSearchFilter({
			searchOn: searchOn ? searchOn.split(',') : false,
			searchConfig: search_config.search.session,
			search,
			modelName: sessionModelName,
			tenantCode: tenantCode,
		})
		// return false response when buildSearchFilter() returns negative response
		// buildSearchFilter() false when search on only contains entity type and no valid matches.
		if (!searchFilter) {
			return {
				rows: [],
				count: 0,
			}
		}

		if (!organizationCode) {
			return responses.failureResponse({
				message: 'ORGANIZATION_CODE_REQUIRED',
				statusCode: httpStatusCode.bad_request,
				responseCode: 'CLIENT_ERROR',
			})
		}

		const defaultRuleFilter = await defaultRulesFilter({
			ruleType: 'session',
			requesterId: userId,
			roles: roles,
			requesterOrganizationCode: organizationCode,
			tenantCode: tenantCode,
		})

		if (defaultRuleFilter.error && defaultRuleFilter.error.missingField) {
			return defaultRuleFilter
		}

		let sessions = await sessionQueries.getUpcomingSessionsFromView(
			page,
			limit,
			searchFilter,
			userId,
			filteredQuery,
			tenantCode,
			saasFilter,
			additionalProjectionString,
			search,
			defaultRuleFilter
		)
		if (sessions && sessions.rows && Array.isArray(sessions.rows) && sessions.rows.length > 0) {
			const uniqueOrgIds = [...new Set(sessions.rows.map((obj) => obj?.mentor_organization_id).filter(Boolean))]
			sessions.rows = await entityTypeService.processEntityTypesToAddValueLabels(
				sessions.rows,
				uniqueOrgIds,
				common.sessionModelName,
				'mentor_organization_id',
				[],
				tenantCode,
				true
			)
		}

		const sessionRows = sessions.rows || sessions
		const processedMenteeDetails = await this.menteeSessionDetails(sessionRows, userId, tenantCode)
		const processedMentorDetails = await this.sessionMentorDetails(processedMenteeDetails, tenantCode)

		if (sessions.rows !== undefined) {
			sessions.rows = processedMentorDetails
		} else {
			sessions = { rows: processedMentorDetails, count: processedMentorDetails.length }
		}

		return sessions
	}

	/**
	 * @description 							- filter sessions based on user's saas policy.
	 * @method
	 * @name filterSessionsBasedOnSaasPolicy
	 * @param {Number} userId 					- User id.
	 * @param {Boolean} isAMentor 				- user mentor or not.
	 * @returns {JSON} 							- List of filtered sessions
	 */
	static async filterSessionsBasedOnSaasPolicy(userId, isAMentor, tenantCode, orgCode) {
		try {
			// Try cache first, then fallback to database for policy checking
			let menteeExtension = await cacheHelper.mentee.getCacheOnly(tenantCode, userId)

			if (!menteeExtension) {
				menteeExtension = await menteeQueries.getMenteeExtension(
					userId,
					['external_session_visibility', 'organization_id', 'is_mentor'],
					false,
					tenantCode
				)
			}

			if (!menteeExtension) {
				throw responses.failureResponse({
					statusCode: httpStatusCode.unauthorized,
					message: 'USER_NOT_FOUND',
					responseCode: 'CLIENT_ERROR',
				})
			}
			// Get organization name with cache-first approach
			let organizationName = ''
			if (menteeExtension?.organization_id) {
				try {
					// Try cache first using available orgCode
					const cachedOrg = await cacheHelper.organizations.get(
						tenantCode,
						orgCode,
						menteeExtension.organization_id
					)

					if (cachedOrg?.name) {
						organizationName = cachedOrg.name
					}
				} catch (cacheError) {
					console.warn('Organization cache lookup failed, falling back to database')
				}

				// Fallback to database if cache miss
				if (!organizationName) {
					const orgDetails = await organisationExtensionQueries.findOne(
						{ organization_id: menteeExtension.organization_id },
						tenantCode,
						{ attributes: ['name', 'organization_code'], raw: true }
					)
					organizationName = orgDetails?.name || ''
				}
			}
			if (!isAMentor && menteeExtension.is_mentor == true) {
				throw responses.failureResponse({
					statusCode: httpStatusCode.unauthorized,
					message: `Congratulations! You are now a mentor in the ${organizationName} organization. Please log in again to begin your journey.`,
					responseCode: 'CLIENT_ERROR',
				})
			} else if (isAMentor && menteeExtension.is_mentor == false) {
				throw responses.failureResponse({
					statusCode: httpStatusCode.unauthorized,
					message: `You are now a mentee in the ${organizationName} organization. Please log in again to continue your journey.`,
					responseCode: 'CLIENT_ERROR',
				})
			}

			const userPolicyDetails = menteeExtension
			let filter = ''
			if (userPolicyDetails.external_session_visibility && userPolicyDetails.organization_id) {
				// generate filter based on condition
				if (userPolicyDetails.external_session_visibility === common.CURRENT) {
					/**
					 * If {userPolicyDetails.external_session_visibility === CURRENT} user will be able to sessions-
					 *  -created by his/her organization mentors.
					 * So will check if mentor_organization_id equals user's  organization_id
					 */
					filter = `AND "mentor_organization_id" = '${userPolicyDetails.organization_id}'`
				} else if (userPolicyDetails.external_session_visibility === common.ASSOCIATED) {
					/**
					 * user external_session_visibility is ASSOCIATED
					 * user can see sessions where session's visible_to_organizations contain user's organization_id and -
					 *  - session's visibility not CURRENT (In case of same organization session has to be fetched for that we added OR condition {"mentor_organization_id" = ${userPolicyDetails.organization_id}})
					 */
					filter = `AND (('${userPolicyDetails.organization_id}' = ANY("visible_to_organizations") AND "visibility" != 'CURRENT') OR "mentor_organization_id" = '${userPolicyDetails.organization_id}')`
				} else if (userPolicyDetails.external_session_visibility === common.ALL) {
					/**
					 * user's external_session_visibility === ALL (ASSOCIATED sessions + sessions whose visibility is ALL)
					 */
					filter = `AND (('${userPolicyDetails.organization_id}' = ANY("visible_to_organizations") AND "visibility" != 'CURRENT' ) OR "visibility" = 'ALL' OR "mentor_organization_id" = '${userPolicyDetails.organization_id}')`
				}
			}
			return filter
		} catch (err) {
			throw err
		}
	}

	/**
	 * Get all enrolled session.
	 * @method
	 * @name getMySessions
	 * @param {Number} page - page No.
	 * @param {Number} limit - page limit.
	 * @param {String} search - search session.
	 * @param {String} userId - user id.
	 * @returns {JSON} - List of enrolled sessions
	 */

	static async getMySessions(page, limit, search, userId, startDate, endDate, tenantCode) {
		try {
			const sessionDetails = await sessionQueries.getEnrolledSessions(
				page,
				limit,
				search,
				userId,
				startDate,
				endDate,
				tenantCode
			)

			if (!sessionDetails || typeof sessionDetails.count !== 'number' || !Array.isArray(sessionDetails.rows)) {
				return { rows: [], count: 0 }
			}
			if (sessionDetails.count > 0) {
				const uniqueOrgIds = [...new Set(sessionDetails.rows.map((obj) => obj.mentor_organization_id))]
				sessionDetails.rows = await entityTypeService.processEntityTypesToAddValueLabels(
					sessionDetails.rows,
					uniqueOrgIds,
					common.sessionModelName,
					'mentor_organization_id',
					[],
					tenantCode,
					true
				)
				sessionDetails.rows = await this.sessionMentorDetails(sessionDetails.rows, tenantCode)
				sessionDetails.rows = sessionDetails.rows.map((r) => ({ ...r, is_enrolled: true }))
			}

			return sessionDetails
		} catch (error) {
			throw error
		}
	}

	/**
	 * Attended sessions list. Only sessions the mentee actually joined (joined_at is set).
	 * @method
	 * @name attendedSessions
	 * @param {String} [userId] - user id whose attended sessions are requested. Defaults to the logged in user.
	 * @param {String} loggedInUserId - logged in user id.
	 * @param {Number} page - page No.
	 * @param {Number} limit - page limit.
	 * @param {String} search - search field.
	 * @param {String} tenantCode - tenant code.
	 * @returns {JSON} - List of attended sessions
	 */

	static async attendedSessions(userId, loggedInUserId, page, limit, search = '', tenantCode) {
		try {
			const menteeId = userId || loggedInUserId

			if (String(menteeId) !== String(loggedInUserId)) {
				// Mentee must belong to the same tenant as the logged in user
				const menteeExtension = await menteeQueries.getMenteeExtension(menteeId, ['user_id'], false, tenantCode)
				if (!menteeExtension) {
					return responses.failureResponse({
						message: 'USER_NOT_FOUND',
						statusCode: httpStatusCode.bad_request,
						responseCode: 'CLIENT_ERROR',
					})
				}
			}

			const sessionDetails = await sessionQueries.getAttendedSessions(page, limit, search, menteeId, tenantCode)

			if (sessionDetails.count > 0) {
				const uniqueOrgIds = [...new Set(sessionDetails.rows.map((obj) => obj.mentor_organization_id))]
				sessionDetails.rows = await entityTypeService.processEntityTypesToAddValueLabels(
					sessionDetails.rows,
					uniqueOrgIds,
					common.sessionModelName,
					'mentor_organization_id',
					[],
					tenantCode,
					true
				)
				sessionDetails.rows = await this.sessionMentorDetails(sessionDetails.rows, tenantCode)
				sessionDetails.rows = sessionDetails.rows.map((r) => ({ ...r, is_enrolled: true }))
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'SESSION_FETCHED_SUCCESSFULLY',
				result: { data: sessionDetails.rows, count: sessionDetails.count },
			})
		} catch (error) {
			throw error
		}
	}

	static async menteeSessionDetails(sessions, userId, tenantCode) {
		try {
			// Handle error objects or non-array data
			if (!Array.isArray(sessions)) {
				return sessions || []
			}

			if (sessions.length > 0) {
				const sessionIds = sessions.map((session) => session.id).filter((id) => id != null)

				if (sessionIds.length === 0) {
					return sessions
				}
				let missingSessionIds = []
				let sessionEnrollmentMap = {}
				for (const sessionId of sessionIds) {
					let sessionInfo = await cacheHelper.sessions.get(tenantCode, sessionId)
					if (sessionInfo) {
						const attendee = sessionInfo?.mentees?.find((m) => String(m.id) === String(userId))
						sessionEnrollmentMap[sessionId] = attendee
							? { is_enrolled: true, enrolled_type: attendee.enrolled_type }
							: { is_enrolled: false }
					} else {
						missingSessionIds.push(sessionId)
					}
				}
				if (missingSessionIds.length > 0) {
					const attendees = await sessionAttendeesQueries.findAll(
						{
							session_id: missingSessionIds,
							mentee_id: userId,
						},
						tenantCode
					)
					for (const sessionId of missingSessionIds) {
						const attendee = attendees.find((a) => a.session_id === sessionId)
						sessionEnrollmentMap[sessionId] = attendee
							? { is_enrolled: true, enrolled_type: attendee.type }
							: { is_enrolled: false }
					}
				}

				return sessions.map((session) => ({
					...session,
					...(sessionEnrollmentMap[session.id] || { is_enrolled: false }),
				}))
			} else {
				return sessions
			}
		} catch (err) {
			return err
		}
	}

	static async sessionMentorDetails(sessions, tenantCode) {
		try {
			if (!sessions || sessions.length === 0) {
				return sessions || []
			}

			// Handle error objects or non-array data
			if (!Array.isArray(sessions)) {
				return sessions || []
			}

			// Extract unique mentor_ids
			const mentorIds = [...new Set(sessions.map((session) => session.mentor_id))]

			// Fetch mentor details
			const mentorDetails = await userRequests.getUserDetailedListUsingCache(mentorIds, tenantCode, false, false)

			// FIX 1: Add null check and filter out null organization_ids
			if (!mentorDetails.result || mentorDetails.result.length === 0) {
				return sessions // Return sessions without mentor details if no mentors found
			}

			// Map mentor names to sessions
			sessions.forEach((session) => {
				const mentor = mentorDetails.result.find((mentorDetail) => mentorDetail.user_id === session.mentor_id)
				if (mentor) {
					session.mentor_name = mentor.name
					session.organization = mentor.organization?.name
				}
			})

			// Fetch and update image URLs in parallel
			await Promise.all(
				sessions.map(async (session) => {
					if (session.image && session.image.length > 0) {
						session.image = await Promise.all(
							session.image.map(async (imgPath) =>
								imgPath ? await utils.getDownloadableUrl(imgPath) : null
							)
						)
					}
				})
			)

			return sessions
		} catch (error) {
			throw error
		}
	}
	// Functions for new APIs
	/**
	 * Create a new mentee extension.
	 * @method
	 * @name createMenteeExtension
	 * @param {Object} data - Mentee extension data to be created.
	 * @param {String} userId - User ID of the mentee.
	 * @returns {Promise<Object>} - Created mentee extension details.
	 */
	static async createMenteeExtension(data, userId, organizationCode, tenantCode, organizationId) {
		try {
			let skipValidation = data.skipValidation ? data.skipValidation : false
			if (data.email) {
				data.email = emailEncryption.encrypt(data.email.toLowerCase())
			}
			// Call user service to fetch organisation details --SAAS related changes
			let userOrgDetails = await userRequests.fetchOrgDetails({ organizationCode, tenantCode })

			// Return error if user org does not exists
			if (!userOrgDetails.success || !userOrgDetails.data || !userOrgDetails.data.result) {
				return responses.failureResponse({
					message: 'ORGANISATION_NOT_FOUND',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			const organization_name = userOrgDetails.data.result.name

			// Find organisation policy from organisation_extension table
			let organisationPolicy = await organisationExtensionQueries.findOrInsertOrganizationExtension(
				organizationId,
				organizationCode,
				organization_name,
				tenantCode
			)
			data.user_id = userId
			data.organization_code = organizationCode

			const defaults = await getDefaults()
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
			const userExtensionsModelName = await menteeQueries.getModelName()

			let entityTypes = await entityTypeCache.getEntityTypesAndEntitiesForModel(
				userExtensionsModelName,
				tenantCode,
				organizationCode
			)
			if (entityTypes instanceof Error) {
				throw entityTypes
			}

			//validationData = utils.removeParentEntityTypes(JSON.parse(JSON.stringify(validationData)))
			const validationData = removeDefaultOrgEntityTypes(entityTypes, organizationCode)

			let res = utils.validateInput(data, validationData, userExtensionsModelName, skipValidation)
			if (!res.success) {
				return responses.failureResponse({
					message: 'MENTEE_EXTENSION_CREATION_FAILED',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
					result: res.errors,
				})
			}
			let menteeExtensionsModel = await menteeQueries.getColumns()
			data = utils.restructureBody(data, validationData, menteeExtensionsModel)

			// construct policy object
			let saasPolicyData = await orgAdminService.constructOrgPolicyObject(organisationPolicy, true)

			userOrgDetails.data.result.related_orgs = userOrgDetails.data.result.related_orgs
				? userOrgDetails.data.result.related_orgs.concat([saasPolicyData.organization_id])
				: [saasPolicyData.organization_id]

			// Update mentee extension creation data
			data = {
				...data,
				...saasPolicyData,
				visible_to_organizations: userOrgDetails.data.result.related_orgs,
			}

			const response = await menteeQueries.createMenteeExtension(data, tenantCode)
			const processDbResponse = utils.processDbResponse(response.toJSON(), validationData)

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'MENTEE_EXTENSION_CREATED',
				result: processDbResponse,
			})
		} catch (error) {
			if (error instanceof UniqueConstraintError) {
				return responses.failureResponse({
					message: 'MENTEE_EXTENSION_EXITS',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}
			return error
		}
	}

	/**
	 * Update a mentee extension.
	 * @method
	 * @name updateMenteeExtension
	 * @param {Object} data - Updated mentee extension data excluding user_id.
	 * @param {String} userId - User ID of the mentee.
	 * @param {String} organizationId - Organization ID for validation.
	 * @returns {Promise<Object>} - Updated mentee extension details.
	 */
	static async updateMenteeExtension(data, userId, organizationCode, tenantCode) {
		try {
			// Encrypt email if provided
			if (data.email) data.email = emailEncryption.encrypt(data.email.toLowerCase())

			let skipValidation = data.skipValidation || false

			// Remove unnecessary data keys
			const dataToRemove = [
				'user_id',
				'mentor_visibility',
				'visible_to_organizations',
				'external_session_visibility',
				'external_mentor_visibility',
				'external_mentee_visibility',
				'mentee_visibility',
			]
			dataToRemove.forEach((key) => delete data[key])

			// Try cache first for current mentee data
			let currentUser = await cacheHelper.mentee.get(tenantCode, userId)
			if (!currentUser) {
				currentUser = await menteeQueries.getMenteeExtension(userId, [], false, tenantCode)
			}
			if (!currentUser) {
				return responses.failureResponse({
					statusCode: httpStatusCode.not_found,
					message: 'MENTEE_EXTENSION_NOT_FOUND',
				})
			}

			// Perform validation

			const defaults = await getDefaults()
			if (!defaults.orgCode)
				return responses.failureResponse({
					message: 'DEFAULT_ORG_CODE_NOT_SET',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})

			if (!defaults.tenantCode)
				return responses.failureResponse({
					message: 'DEFAULT_ORG_CODE_NOT_SET',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})

			const userExtensionsModelName = await menteeQueries.getModelName()
			const filter = {
				status: common.ACTIVE_STATUS,
				organization_code: { [Op.in]: [organizationCode, defaults.orgCode] },
				model_names: { [Op.contains]: [userExtensionsModelName] },
			}
			let entityTypes = await entityTypeCache.getEntityTypesAndEntitiesWithCache(
				filter,
				tenantCode,
				organizationCode,
				userExtensionsModelName
			)
			if (entityTypes instanceof Error) {
				throw entityTypes
			}

			const validationData = removeDefaultOrgEntityTypes(entityTypes, organizationCode)
			let res = utils.validateInput(data, validationData, userExtensionsModelName, skipValidation)
			if (!res.success) {
				return responses.failureResponse({
					message: 'PROFILE_UPDATE_FAILED',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
					result: res.errors,
				})
			}

			// Restructure the data
			let userExtensionModel = await menteeQueries.getColumns()
			data = utils.restructureBody(data, validationData, userExtensionModel)

			// Handle organization update logic if organization data is provided
			if (data?.organization?.id) {
				//Do a org policy update for the user only if the data object explicitly includes an
				//organization.id. This is added for the users/update workflow where
				//both both user data and organisation can change at the same time.
				let userOrgDetails = await userRequests.fetchOrgDetails({
					organizationCode: organizationCode,
					tenantCode,
				})
				const orgPolicies = await organisationExtensionQueries.findOrInsertOrganizationExtension(
					data.organization_id,
					organizationCode,
					userOrgDetails.data.result.name,
					tenantCode
				)
				if (!orgPolicies?.organization_id) {
					return responses.failureResponse({
						message: 'ORG_EXTENSION_NOT_FOUND',
						statusCode: httpStatusCode.bad_request,
						responseCode: 'CLIENT_ERROR',
					})
				}
				data.organization_id = data.organizationid
				const newPolicy = await orgAdminService.constructOrgPolicyObject(orgPolicies, true)
				data = _.merge({}, data, newPolicy)
				data.visible_to_organizations = Array.from(
					new Set([...userOrgDetails.data.result.related_orgs, data.organization.id])
				)
			}

			// Update the database
			const [updateCount, updatedUser] = await menteeQueries.updateMenteeExtension(
				userId,
				data,
				{
					returning: true,
					raw: true,
				},
				{},
				tenantCode
			)

			if (currentUser?.meta?.communications_user_id) {
				const promises = []
				if (data.name && data.name !== currentUser.name) {
					promises.push(communicationHelper.updateUser(userId, data.name, tenantCode))
				}

				if (data.image && data.image !== currentUser.image) {
					const downloadableUrl = (await userRequests.getDownloadableUrl(data.image))?.result
					promises.push(communicationHelper.updateAvatar(userId, downloadableUrl, tenantCode))
				}

				await Promise.all(promises)
			}

			if (updateCount === 0) {
				// Try cache first for fallback data
				let fallbackUpdatedUser = await cacheHelper.mentee.get(tenantCode, userId)
				if (!fallbackUpdatedUser) {
					fallbackUpdatedUser = await menteeQueries.getMenteeExtension(userId, [], false, tenantCode)
				}
				if (!fallbackUpdatedUser) {
					return responses.failureResponse({
						statusCode: httpStatusCode.not_found,
						message: 'MENTEE_EXTENSION_NOT_FOUND',
					})
				}
				const processDbResponse = utils.processDbResponse(fallbackUpdatedUser, validationData)

				return responses.successResponse({
					statusCode: httpStatusCode.ok,
					message: 'MENTEE_EXTENSION_UPDATED',
					result: processDbResponse,
				})
			}

			// Return updated data
			const processDbResponse = utils.processDbResponse(updatedUser[0], validationData)

			// Delete old cache and cache the new updated data
			if (userId && organizationCode) {
				try {
					// Delete old cache first
					await cacheHelper.mentee.delete(tenantCode, userId)
				} catch (cacheError) {
					console.error(`❌ Failed to update mentee cache after update:`, cacheError)
				}
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'MENTEE_EXTENSION_UPDATED',
				result: processDbResponse,
			})
		} catch (error) {
			return error
		}
	}

	/**
	 * Get mentee extension details by user ID.
	 * @method
	 * @name getMenteeExtension
	 * @param {String} userId - User ID of the mentee.
	 * @returns {Promise<Object>} - Mentee extension details.
	 */
	static async getMenteeExtension(userId, organizationCode, tenantCode) {
		try {
			// Try cache first for processed mentee extension data
			const cachedMenteeExtension = await cacheHelper.mentee.get(tenantCode, userId)
			if (cachedMenteeExtension) {
				// Always generate fresh downloadable URL for image (cached URLs expire)
				if (cachedMenteeExtension.image) {
					try {
						cachedMenteeExtension.image = await utils.getDownloadableUrl(cachedMenteeExtension.image)
					} catch (error) {
						console.error(`Failed to get downloadable URL for cached mentee image:`, error)
						cachedMenteeExtension.image = null
					}
				}

				return responses.successResponse({
					statusCode: httpStatusCode.ok,
					message: 'MENTEE_EXTENSION_FETCHED',
					result: cachedMenteeExtension,
				})
			}

			const mentee = await menteeQueries.getMenteeExtension(userId, [], false, tenantCode)
			if (!mentee) {
				return responses.failureResponse({
					statusCode: httpStatusCode.not_found,
					message: 'MENTEE_EXTENSION_NOT_FOUND',
				})
			}

			const defaults = await getDefaults()
			if (!defaults.orgCode)
				return responses.failureResponse({
					message: 'DEFAULT_ORG_CODE_NOT_SET',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})

			if (!defaults.tenantCode)
				return responses.failureResponse({
					message: 'DEFAULT_ORG_CODE_NOT_SET',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})

			const userExtensionsModelName = await menteeQueries.getModelName()
			const filter = {
				status: common.ACTIVE_STATUS,
				organization_code: { [Op.in]: [organizationCode, defaults.orgCode] },
				model_names: { [Op.contains]: [userExtensionsModelName] },
			}

			let entityTypes = await entityTypeCache.getEntityTypesAndEntitiesWithCache(
				filter,
				tenantCode,
				organizationCode,
				userExtensionsModelName
			)

			//validationData = utils.removeParentEntityTypes(JSON.parse(JSON.stringify(validationData)))
			const validationData = removeDefaultOrgEntityTypes(entityTypes, organizationCode)
			const processDbResponse = utils.processDbResponse(mentee, validationData)

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'MENTEE_EXTENSION_FETCHED',
				result: processDbResponse,
			})
		} catch (error) {
			return error
		}
	}

	/**
	 * Delete a mentee extension by user ID.
	 * @method
	 * @name deleteMenteeExtension
	 * @param {String} userId - User ID of the mentee.
	 * @returns {Promise<Object>} - Indicates if the mentee extension was deleted successfully.
	 */
	static async deleteMenteeExtension(userId, tenantCode) {
		try {
			const deleteCount = await menteeQueries.deleteMenteeExtension(userId, tenantCode)
			if (deleteCount === '0') {
				return responses.failureResponse({
					statusCode: httpStatusCode.not_found,
					message: 'MENTEE_EXTENSION_NOT_FOUND',
				})
			}
			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'MENTEE_EXTENSION_DELETED',
			})
		} catch (error) {
			return error
		}
	}

	/**
	 * Get entities and organization filter
	 * @method
	 * @name getFilterList
	 * @param {String} tokenInformation - token information
	 * @param {Boolean} queryParams - queryParams
	 * @returns {JSON} - Filter list.
	 */
	static async getFilterList(organization, entity_type, filterType, tokenInformation, tenantCode) {
		try {
			let result = {
				organizations: [],
				entity_types: {},
			}

			const filter_type = filterType !== '' ? filterType : common.MENTOR_ROLE

			let organization_codes = []
			let organizationInfo = []
			const organizations = await getOrgIdAndEntityTypes.getOrganizationIdBasedOnPolicy(
				tokenInformation.id,
				tokenInformation.organization_code,
				filter_type,
				tenantCode
			)

			const defaults = await getDefaults()

			if (organizations && organizations.result.organizationInfo?.length > 0) {
				organization_codes = organizations.result.organizationCodes

				organizationInfo = organizations.result.organizationInfo
				if (organizationInfo.length > 1) {
					organizationInfo = organizationInfo.filter((orgCode) => orgCode != defaults.orgCode)
				}
				result.organizations = organizationInfo

				const modelName = []

				const queryMap = {
					[common.MENTEE_ROLE]: menteeQueries.getModelName,
					[common.MENTOR_ROLE]: mentorQueries.getModelName,
					[common.SESSION]: sessionQueries.getModelName,
				}

				if (queryMap[filter_type.toLowerCase()]) {
					const modelNameResult = await queryMap[filter_type.toLowerCase()]()
					modelName.push(modelNameResult)
				}
				// get entity type with entities list
				const getEntityTypesWithEntities = await getOrgIdAndEntityTypes.getEntityTypeWithEntitiesBasedOnOrg(
					organization_codes,
					entity_type,
					defaults.orgCode ? defaults.orgCode : '',
					modelName,
					{},
					tenantCode
				)
				if (getEntityTypesWithEntities.success && getEntityTypesWithEntities.result) {
					let entityTypesWithEntities = getEntityTypesWithEntities.result
					if (entityTypesWithEntities.length > 0) {
						let convertedData = utils.convertEntitiesForFilter(entityTypesWithEntities)
						let doNotRemoveDefaultOrg = false
						if (organization_codes.includes(defaults.orgCode)) {
							doNotRemoveDefaultOrg = true
						}
						result.entity_types = utils.filterEntitiesBasedOnParent(
							convertedData,
							defaults.orgCode,
							doNotRemoveDefaultOrg
						)
					}
				}
			}

			if (organization.toLowerCase() === common.FALSE) {
				delete result.organizations
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'FILTER_FETCHED_SUCCESSFULLY',
				result,
			})
		} catch (error) {
			return error
		}
	}

	/* List mentees and search with name , email
	 * @method
	 * @name list
	 * @param {String} userId - User ID of the mentee.
	 * @param {Number} pageNo - Page No.
	 * @param {Number} pageSize - Page Size.
	 * @param {String} searchText
	 * @param {String} queryParams
	 * @param {String} userId
	 * @param {Boolean} isAMentor - true/false.
	 * @returns {Promise<Object>} - returns the list of mentees
	 */
	static async list(pageNo, pageSize, searchText, queryParams, userId, isAMentor, organizationCode, tenantCode) {
		try {
			let additionalProjectionString = ''

			// check for fields query
			if (queryParams.fields && queryParams.fields !== '') {
				additionalProjectionString = queryParams.fields
				delete queryParams.fields
			}

			// Parse organization codes from query parameters
			let organization_codes = []
			if (queryParams.hasOwnProperty('organization_ids')) {
				organization_codes = queryParams['organization_ids'].split(',')
			}

			// Extract sort parameters
			const [sortBy, order] = ['name'].includes(queryParams.sort_by)
				? [queryParams.sort_by, queryParams.order || 'ASC']
				: [false, 'ASC']

			const query = utils.processQueryParametersWithExclusions(queryParams)
			const userExtensionModelName = await menteeQueries.getModelName()

			let connectedMenteeIds = []
			let connectedMenteesCount
			if (queryParams.connected_mentees === 'true') {
				const connectedQueryParams = { ...queryParams }
				delete connectedQueryParams.connected_mentees
				const connectedQuery = utils.processQueryParametersWithExclusions(connectedQueryParams)

				const connectionDetails = await connectionQueries.getConnectionsDetails(
					pageNo,
					pageSize,
					connectedQuery,
					searchText,
					queryParams.mentorId ? queryParams.mentorId : userId,
					organization_codes,
					[], // roles can be passed if needed
					tenantCode
				)

				if (connectionDetails?.data?.length > 0) {
					pageNo = null
					pageSize = null
					connectedMenteeIds = connectionDetails.data.map((item) => item.user_id)
					// if (!connectedMenteeIds.includes(userId)) {
					// 	connectedMenteeIds.push(userId)
					// }
				}
				if (typeof connectionDetails?.count === 'number') {
					connectedMenteesCount = connectionDetails.count
				}

				// If there are no connected mentees, short-circuit and return empty
				if (connectedMenteeIds.length === 0) {
					return responses.successResponse({
						statusCode: httpStatusCode.ok,
						message: 'MENTEE_LIST',
						result: {
							data: [],
							count: 0,
						},
					})
				}
			}

			const defaults = await getDefaults()
			if (!defaults.tenantCode)
				return responses.failureResponse({
					message: 'DEFAULT_ORG_CODE_NOT_SET',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})

			const validationData = await entityTypeCache.getEntityTypesAndEntitiesForModel(
				userExtensionModelName,
				tenantCode,
				organizationCode
			)

			let filteredQuery = utils.validateAndBuildFilters(query, validationData)

			const emailIds = []
			const searchTextArray = searchText ? searchText.split(',') : []

			searchTextArray.forEach((element) => {
				if (utils.isValidEmail(element)) {
					emailIds.push(emailEncryption.encrypt(element.toLowerCase()))
				}
			})
			const hasValidEmails = emailIds.length > 0

			const saasFilter = await this.filterMenteeListBasedOnSaasPolicy(
				userId,
				isAMentor,
				organization_codes,
				tenantCode,
				organizationCode
			)
			let extensionDetails = await menteeQueries.getAllUsers(
				connectedMenteeIds ? connectedMenteeIds : [],
				pageNo,
				pageSize,
				filteredQuery,
				saasFilter,
				additionalProjectionString,
				false,
				hasValidEmails ? emailIds : searchText,
				'', // defaultFilter
				tenantCode
			)

			if (extensionDetails?.data.length == 0) {
				return responses.successResponse({
					statusCode: httpStatusCode.ok,
					message: 'MENTEE_LIST',
					result: extensionDetails,
				})
			}

			const uniqueOrgs = []
			extensionDetails.data.forEach((item) => {
				if (!uniqueOrgs.some((o) => o.organization_code === item.organization_code)) {
					uniqueOrgs.push({
						organization_id: item.organization_id,
						organization_code: item.organization_code,
					})
				}
			})

			let orgnisationData = await getOrganizationHelper.organizationListFromCache(uniqueOrgs, tenantCode)
			const orgMap = {}
			orgnisationData.forEach((org) => {
				orgMap[org.organization_id] = {
					id: org.organization_id,
					name: org.name,
				}
			})

			//Attach organization details and decrypt email for each user
			extensionDetails.data = await Promise.all(
				extensionDetails.data.map(async (user) => {
					let decryptedEmail = null
					if (user.email) {
						try {
							decryptedEmail = await emailEncryption.decrypt(user.email)
						} catch (decryptError) {
							decryptedEmail = null
						}
					}

					let imageUrl = null
					if (user.image) {
						try {
							imageUrl = (await utils.getDownloadableUrl(user.image)) ?? null
						} catch (error) {
							console.error(`Failed to get downloadable URL for user ${user.user_id}:`, error)
							imageUrl = null
						}
					}

					return {
						...user,
						id: user.user_id, // Add 'id' key, to be removed later
						email: decryptedEmail,
						organization: orgMap[user.organization_id] || null,
						image: imageUrl,
					}
				})
			)

			// Step 5: Process entity types (reuse organizationIds) with error handling
			if (extensionDetails.data.length > 0) {
				try {
					const organizationCodes = uniqueOrgs.map((org) => org.organization_code).filter(Boolean)
					const processedData = await entityTypeService.processEntityTypesToAddValueLabels(
						extensionDetails.data,
						organizationCodes,
						userExtensionModelName,
						'organization_code',
						[],
						tenantCode
					)
					if (Array.isArray(processedData)) {
						extensionDetails.data = processedData
					}
				} catch (entityError) {
					console.error('Error processing entity types:', entityError)
					throw entityError
				}
			}

			// Step 6: Handle session enrollment
			if (queryParams.session_id) {
				const enrolledMentees =
					(await cacheHelper.sessions.get(tenantCode, queryParams.session_id)) ??
					(await getEnrolledMentees(queryParams.session_id, {}, tenantCode))
				extensionDetails.data.forEach((user) => {
					user.is_enrolled = false
					const enrolledUser = _.find(enrolledMentees, { id: user.id })
					if (enrolledUser) {
						user.is_enrolled = true
						user.enrolled_type = enrolledUser.type
					}
				})
			}

			// Step 7: Apply sorting if sortBy is provided
			if (sortBy) {
				extensionDetails.data = extensionDetails.data.sort((a, b) => {
					const sortOrder = order.toLowerCase() === 'asc' ? 1 : order.toLowerCase() === 'desc' ? -1 : 1
					return sortOrder * a[sortBy].localeCompare(b[sortBy])
				})
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'MENTEE_LIST',
				result: {
					data: extensionDetails.data,
					count: extensionDetails.count,
				},
			})
		} catch (error) {
			throw error
		}
	}
	static async filterMenteeListBasedOnSaasPolicy(userId, isAMentor, organizationCodes = [], tenantCode, orgCode) {
		try {
			// let extensionColumns = isAMentor ? await mentorQueries.getColumns() : await menteeQueries.getColumns()
			// // check for external_mentee_visibility else fetch external_mentor_visibility
			// extensionColumns = extensionColumns.includes('external_mentee_visibility')
			// 	? ['external_mentee_visibility', 'organization_id']
			// 	: ['external_mentor_visibility', 'organization_id']

			// Get raw data from database for policy checking (need specific raw columns)
			const userPolicyDetails = isAMentor
				? await mentorQueries.getMentorExtension(
						userId,
						['external_mentee_visibility', 'organization_id', 'organization_code'],
						false,
						tenantCode
				  )
				: await menteeQueries.getMenteeExtension(
						userId,
						['external_mentee_visibility', 'organization_id', 'organization_code'],
						false,
						tenantCode
				  )

			// Get organization policy with cache-first approach
			let getOrgPolicy = null

			// Try cache first using available orgCode and organization_id
			try {
				const cachedOrg = await cacheHelper.organizations.get(
					tenantCode,
					orgCode,
					userPolicyDetails.organization_id
				)

				// Check if cached data has the required policy attribute
				if (cachedOrg && cachedOrg.hasOwnProperty('external_mentee_visibility_policy')) {
					getOrgPolicy = cachedOrg
				}
			} catch (cacheError) {
				console.warn('Organization cache lookup failed, falling back to database')
			}

			// Fallback to database if cache miss
			if (!getOrgPolicy) {
				getOrgPolicy = await organisationExtensionQueries.findOne(
					{
						organization_id: userPolicyDetails.organization_id,
					},
					tenantCode,
					{
						attributes: ['external_mentee_visibility_policy', 'organization_id', 'organization_code'],
					}
				)
			}
			// Throw error if mentor/mentee extension not found
			if (!userPolicyDetails || Object.keys(userPolicyDetails).length === 0) {
				return responses.failureResponse({
					statusCode: httpStatusCode.not_found,
					message: isAMentor ? 'MENTORS_NOT_FOUND' : 'MENTEE_EXTENSION_NOT_FOUND',
					responseCode: 'CLIENT_ERROR',
				})
			}

			let filter = ''
			let additionalFilter = ''

			if (organizationCodes.length !== 0) {
				additionalFilter = `AND "organization_code" in (${organizationCodes
					.map((code) => `'${code}'`)
					.join(',')}) `
			}
			const requesterOrgCode = userPolicyDetails.organization_code
			const requesterOrgId = userPolicyDetails.organization_id

			// Important: visible_to_organizations stores organization IDs (from related_orgs), not codes
			// So we must use organization_id when checking visible_to_organizations
			if (getOrgPolicy?.external_mentee_visibility_policy && requesterOrgCode && requesterOrgId) {
				const visibilityPolicy = getOrgPolicy.external_mentee_visibility_policy

				// Filter user data based on policy
				// generate filter based on condition
				if (visibilityPolicy === common.CURRENT) {
					/**
					 * if user external_mentor_visibility is current. He can only see his/her organizations mentors
					 * so we will check mentor's organization_id and user organization_id are matching
					 */
					filter = `AND "organization_code" = '${requesterOrgCode}'`
				} else if (visibilityPolicy === common.ASSOCIATED) {
					/**
					 * If user external_mentor_visibility is associated
					 * <<point**>> first we need to check if mentor's visible_to_organizations contain the user organization_id and verify mentor's visibility is not current (if it is ALL and ASSOCIATED it is accessible)
					 */
					filter =
						additionalFilter +
						`AND ( ('${requesterOrgId}' = ANY("visible_to_organizations") AND "mentee_visibility" != 'CURRENT')`

					if (additionalFilter.length === 0) filter += ` OR organization_code = '${requesterOrgCode}' )`
					else filter += `)`
				} else if (visibilityPolicy === common.ALL) {
					/**
					 * We need to check if mentor's visible_to_organizations contain the user organization_id and verify mentor's visibility is not current (if it is ALL and ASSOCIATED it is accessible)
					 * OR if mentor visibility is ALL that mentor is also accessible
					 */
					filter =
						additionalFilter +
						`AND (('${requesterOrgId}' = ANY("visible_to_organizations") AND "mentee_visibility" != 'CURRENT' ) OR "mentee_visibility" = 'ALL' OR "organization_code" = '${requesterOrgCode}')`
				}
			}

			return filter
		} catch (err) {
			return err
		}
	}

	/**
	 * @description 							- check if mentee is accessible based on user's saas policy.
	 * @method
	 * @name checkIfMenteeIsAccessible
	 * @param {Number} userId 					- User id.
	 * @param {Array} userData					- User data
	 * @param {Boolean} isAMentor 				- user mentor or not.
	 * @param {String} tenantCode 				- tenant code.
	 * @param {String} orgCode 					- organization code (optional, for cache optimization).
	 * @returns {Boolean} 						- user Accessible
	 */

	static async checkIfMenteeIsAccessible(userData, userId, isAMentor, tenantCode, orgCode) {
		try {
			// Get raw data from database for policy checking (need specific raw columns)
			const userPolicyDetails = isAMentor
				? await mentorQueries.getMentorExtension(
						userId,
						['external_mentee_visibility', 'organization_id'],
						false,
						tenantCode
				  )
				: await menteeQueries.getMenteeExtension(
						userId,
						['external_mentee_visibility', 'organization_id'],
						false,
						tenantCode
				  )

			// Throw error if mentor/mentee extension not found
			if (!userPolicyDetails || Object.keys(userPolicyDetails).length === 0) {
				return responses.failureResponse({
					statusCode: httpStatusCode.not_found,
					message: isAMentor ? 'MENTORS_NOT_FOUND' : 'MENTEE_EXTENSION_NOT_FOUND',
					responseCode: 'CLIENT_ERROR',
				})
			}

			// check the accessibility conditions
			const accessibleUsers = userData.map((mentee) => {
				let isAccessible = false

				if (userPolicyDetails.external_mentee_visibility && userPolicyDetails.organization_id) {
					const { external_mentee_visibility, organization_id } = userPolicyDetails

					switch (external_mentee_visibility) {
						/**
						 * if user external_mentee_visibility is current. He can only see his/her organizations mentee
						 * so we will check mentee's organization_id and user organization_id are matching
						 */
						case common.CURRENT:
							isAccessible = mentee.organization_id === organization_id
							break
						/**
						 * If user external_mentee_visibility is associated
						 * <<point**>> first we need to check if mentee's visible_to_organizations contain the user organization_id and verify mentee's visibility is not current (if it is ALL and ASSOCIATED it is accessible)
						 */
						case common.ASSOCIATED:
							isAccessible =
								(mentee.visible_to_organizations.includes(organization_id) &&
									mentee.mentee_visibility != common.CURRENT) ||
								mentee.organization_id === organization_id
							break
						/**
						 * We need to check if mentee's visible_to_organizations contain the user organization_id and verify mentee's visibility is not current (if it is ALL and ASSOCIATED it is accessible)
						 * OR if mentee visibility is ALL that mentee is also accessible
						 */
						case common.ALL:
							isAccessible =
								(mentee.visible_to_organizations.includes(organization_id) &&
									mentee.mentee_visibility != common.CURRENT) ||
								mentee.mentee_visibility === common.ALL ||
								mentee.organization_id === organization_id
							break
						default:
							break
					}
				}
				return { mentee, isAccessible }
			})
			const isAccessible = accessibleUsers.some((user) => user.isAccessible)
			return isAccessible
		} catch (error) {
			return error
		}
	}

	/**
	 * Retrieves a communication token for the logged in user.
	 *
	 * This asynchronous method logs in a user using their unique identifier (`id`)
	 * to obtain a communication token and other relevant details, then returns a
	 * standardized success response with the token, user ID, and metadata.
	 *
	 * @async
	 * @function getCommunicationToken
	 * @param {string} id - The unique identifier of the user for whom the communication token is to be retrieved.
	 * @returns {Promise<Object>} A promise that resolves to an object containing the response code, message, result data,
	 * and additional metadata.
	 *
	 * @throws {Error} If the communicationHelper login process fails, this method may throw an error.
	 *
	 * @example
	 * const response = await getCommunicationToken(123);

	 * // {
	 * //   responseCode: "OK",
	 * //   message: "Communication token fetched successfully!",
	 * //   result: {
	 * //     auth_token: "_GTFHENH422lGlLcgYQfu2GnnWO8bg6zY8ZHrXkcNmN",
	 * //     user_id: "Q9hz3jbPXkk3fXQoL"
	 * //   },
	 * //   meta: {
	 * //     correlation: "69893cb9-8b0c-44f9-945e-1bff2174af0d",
	 * //     meetingPlatform: "BBB"
	 * //   }
	 * // }
	 */
	static async getCommunicationToken(id, tenantCode, orgCode) {
		try {
			const token = await communicationHelper.login(id, tenantCode)

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'COMMUNICATION_TOKEN_FETCHED_SUCCESSFULLY',
				result: token,
			})
		} catch (error) {
			if (error.message == 'unauthorized' || error.message.includes('USER_NOT_FOUND')) {
				try {
					// Step 1: Try to get user details from cache first for better performance
					let user = null

					user =
						(await cacheHelper.mentor.getCacheOnly(tenantCode, id)) ??
						(await cacheHelper.mentee.getCacheOnly(tenantCode, id))

					// Step 2: Fallback to database if cache miss (include encrypted email field)
					if (!user) {
						user = await menteeQueries.getMenteeExtension(id, [], true, tenantCode)
					}

					if (!user) {
						return responses.failureResponse({
							statusCode: httpStatusCode.not_found,
							message: 'USER_NOT_FOUND',
							responseCode: 'CLIENT_ERROR',
						})
					}

					// Step 3: Validate required email field
					if (!user.email) {
						return responses.failureResponse({
							statusCode: httpStatusCode.bad_request,
							message: 'USER_EMAIL_REQUIRED_FOR_COMMUNICATION_SIGNUP',
							responseCode: 'CLIENT_ERROR',
						})
					}

					// Step 4: Generate downloadable image URL if user has image
					let userImageUrl = null
					if (user.image) {
						try {
							const imageResponse = await userRequests.getDownloadableUrl(user.image)
							userImageUrl = imageResponse?.result
							console.log(`💾 Generated downloadable image URL for user ${id}`)
						} catch (imageError) {
							console.log(`Failed to generate image URL for user ${id}:`, imageError.message)
							// Continue without image - not a blocking error
						}
					}

					// Step 5: Attempt signup with user details including generated image URL
					await communicationHelper.create(id, user.name, user.email, userImageUrl, tenantCode)
					console.log(`💾 Created communication user for ${id} with ${userImageUrl ? 'image' : 'no image'}`)

					// Step 6: Retry login after successful signup
					const token = await communicationHelper.login(id, tenantCode)

					return responses.successResponse({
						statusCode: httpStatusCode.ok,
						message: 'COMMUNICATION_TOKEN_FETCHED_SUCCESSFULLY_AFTER_SIGNUP',
						result: token,
					})
				} catch (signupError) {
					return responses.failureResponse({
						statusCode: httpStatusCode.internal_server_error,
						message: 'COMMUNICATION_SIGNUP_AND_LOGIN_FAILED',
						responseCode: 'SERVER_ERROR',
					})
				}
			}

			// Handle all other errors
			return responses.failureResponse({
				statusCode: httpStatusCode.internal_server_error,
				message: 'COMMUNICATION_TOKEN_FETCH_FAILED',
				responseCode: 'SERVER_ERROR',
			})
		}
	}

	/**
	 * Logs out a user by invoking the `communicationHelper.logout` function and
	 * returns a success response upon successful logout. If the logout fails due to
	 * an unauthorized error, returns a failure response indicating that the communication
	 * token was not found.
	 *
	 * @async
	 * @function logout
	 * @param {string} id - The ID of the user to be logged out.
	 * @returns {Promise<Object>} Resolves with a success response object if the logout is successful,
	 * or a failure response object if an unauthorized error occurs.
	 *
	 * @throws {Error} If an error other than 'unauthorized' occurs, it will not be caught here and may be handled upstream.
	 */
	static async logout(id, tenantCode) {
		try {
			const response = await communicationHelper.logout(id, tenantCode)

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'USER_LOGGED_OUT',
				result: response,
			})
		} catch (error) {
			if (error.message === 'unauthorized') {
				return responses.failureResponse({
					statusCode: httpStatusCode.not_found,
					message: 'COMMUNICATION_TOKEN_NOT_FOUND',
					responseCode: 'CLIENT_ERROR',
				})
			}
			throw error // rethrow other errors to be handled by a higher-level error handler
		}
	}

	static async details(id, organizationCode, userId = '', isAMentor = '', roles = '', tenantCode) {
		try {
			// Try cache first using logged-in user's organization context
			const cacheProfileDetails = await cacheHelper.mentee.getCacheOnly(tenantCode, id)
			if (cacheProfileDetails) {
				if (cacheProfileDetails.is_mentor == true) {
					// Get mentor visibility and org id
					const validateDefaultRules = await validateDefaultRulesFilter({
						ruleType: common.DEFAULT_RULES.MENTOR_TYPE,
						requesterId: userId,
						roles: roles,
						requesterOrganizationCode: organizationCode,
						data: cacheProfileDetails,
						tenantCode: tenantCode,
					})
					if (validateDefaultRules.error && validateDefaultRules.error.missingField) {
						return responses.failureResponse({
							message: 'PROFILE_NOT_UPDATED',
							statusCode: httpStatusCode.bad_request,
							responseCode: 'CLIENT_ERROR',
						})
					}
					if (!validateDefaultRules) {
						return responses.failureResponse({
							message: 'USER_NOT_FOUND',
							statusCode: httpStatusCode.forbidden,
							responseCode: 'CLIENT_ERROR',
						})
					}
				}
				// Check for accessibility for reading shared mentor profile
				const isAccessible = await checkIfUserIsAccessible(
					userId,
					cacheProfileDetails,
					tenantCode,
					organizationCode
				)

				// Throw access error
				if (!isAccessible) {
					return responses.failureResponse({
						statusCode: httpStatusCode.forbidden,
						message: 'PROFILE_RESTRICTED',
					})
				}

				// Always fetch is_connected from database as it changes based on who is calling
				const connection = await connectionQueries.getConnection(userId, id, tenantCode)
				cacheProfileDetails.is_connected = Boolean(connection)

				if (cacheProfileDetails.is_connected) {
					cacheProfileDetails.connection_details = connection.meta
				}

				// Always generate fresh downloadable URL for image (cached URLs expire)
				if (cacheProfileDetails.image) {
					try {
						cacheProfileDetails.image = await utils.getDownloadableUrl(cacheProfileDetails.image)
					} catch (error) {
						console.error(`Failed to get downloadable URL for cached profile image:`, error)
						cacheProfileDetails.image = null
					}
				}

				return responses.successResponse({
					statusCode: httpStatusCode.ok,
					message: 'PROFILE_FTECHED_SUCCESSFULLY',
					result: cacheProfileDetails,
				})
			}

			// If we don't have cached data, fetch it from database
			let requestedUserExtension
			if (!cacheProfileDetails) {
				requestedUserExtension = await menteeQueries.getMenteeExtension(id, [], false, tenantCode)
			}

			if (!requestedUserExtension || (!isAMentor && requestedUserExtension.is_mentor == false)) {
				return responses.failureResponse({
					statusCode: httpStatusCode.not_found,
					message: 'USER_NOT_FOUND',
					responseCode: 'CLIENT_ERROR',
				})
			}
			let totalSessionHosted
			if (requestedUserExtension.is_mentor == true) {
				// Get mentor visibility and org id
				const validateDefaultRules = await validateDefaultRulesFilter({
					ruleType: common.DEFAULT_RULES.MENTOR_TYPE,
					requesterId: userId,
					roles: roles,
					requesterOrganizationCode: organizationCode,
					data: requestedUserExtension,
					tenantCode: tenantCode,
				})
				if (validateDefaultRules.error && validateDefaultRules.error.missingField) {
					return responses.failureResponse({
						message: 'PROFILE_NOT_UPDATED',
						statusCode: httpStatusCode.bad_request,
						responseCode: 'CLIENT_ERROR',
					})
				}
				if (!validateDefaultRules) {
					return responses.failureResponse({
						message: 'USER_NOT_FOUND',
						statusCode: httpStatusCode.forbidden,
						responseCode: 'CLIENT_ERROR',
					})
				}
				totalSessionHosted = await sessionQueries.countHostedSessions(id, tenantCode)
			}
			// Check for accessibility for reading shared mentor profile
			const isAccessible = await checkIfUserIsAccessible(
				userId,
				requestedUserExtension,
				tenantCode,
				organizationCode
			)

			// Throw access error
			if (!isAccessible) {
				return responses.failureResponse({
					statusCode: httpStatusCode.forbidden,
					message: 'PROFILE_RESTRICTED',
				})
			}

			let mentorExtension
			if (requestedUserExtension) mentorExtension = requestedUserExtension
			else mentorExtension = await mentorQueries.getMentorExtension(id, [], false, tenantCode)

			mentorExtension = utils.deleteProperties(mentorExtension, [
				'user_id',
				'visible_to_organizations',
				'image',
				'email',
				'phone',
				'settings',
			])

			const menteeExtensionsModelName = await menteeQueries.getModelName()

			let entityTypes = await entityTypeCache.getEntityTypesAndEntitiesForModel(
				menteeExtensionsModelName,
				tenantCode,
				requestedUserExtension.organization_code
			)

			// validationData = utils.removeParentEntityTypes(JSON.parse(JSON.stringify(validationData)))
			const validationData = removeDefaultOrgEntityTypes(entityTypes, requestedUserExtension.organization_code)
			const processDbResponse = utils.processDbResponse(mentorExtension, validationData)

			const profileMandatoryFields = await utils.validateProfileData(processDbResponse, validationData)

			processDbResponse.profile_mandatory_fields = profileMandatoryFields

			const connection = await connectionQueries.getConnection(userId, id, tenantCode)

			// Get organization details with cache optimization
			let orgDetails = null
			try {
				// Try cache first if we have organization_id
				if (requestedUserExtension.organization_id) {
					orgDetails = await cacheHelper.organizations.get(
						tenantCode,
						requestedUserExtension.organization_code,
						requestedUserExtension.organization_id
					)
				}
			} catch (cacheError) {
				console.warn('Organization cache lookup failed, falling back to database query')
			}

			// Fallback to database if cache miss
			if (!orgDetails) {
				orgDetails = await organisationExtensionQueries.findOne(
					{ organization_code: requestedUserExtension.organization_code },
					tenantCode,
					{ attributes: ['name', 'organization_code', 'organization_id'] }
				)
			}
			processDbResponse['organization'] = {
				id: orgDetails.organization_code,
				name: orgDetails.name,
			}

			const totalSessionsAttendedDetails = await sessionAttendeesQueries.countEnrolledSessions(id, tenantCode)

			processDbResponse.sessions_attended = totalSessionsAttendedDetails
			processDbResponse.sessions_hosted = totalSessionHosted

			processDbResponse.is_connected = Boolean(connection)

			if (processDbResponse.is_connected) {
				processDbResponse.connection_details = connection.meta
			}

			// Try to get display properties from cache (with tenant/org fallback)
			let displayProperties = await cacheHelper.displayProperties.get(tenantCode, organizationCode)

			if (!displayProperties) {
				// Build display properties from entity types
				const sortedEntityType = await utils.sortData(validationData, 'meta.sequence')
				displayProperties = [
					{
						key: 'organization',
						label: 'Organization',
						visible: true,
						visibility: 'main',
						sequence: 1,
					},
				]
				for (const entityType of sortedEntityType) {
					displayProperties.push({ key: entityType.value, ...entityType.meta })
				}

				// Cache at both org and tenant levels for better hit rates
				try {
					await cacheHelper.displayProperties.set(tenantCode, organizationCode, displayProperties)
				} catch (cacheError) {
					console.error(`❌ Failed to cache display properties:`, cacheError)
				}
			}

			// Get permissions for the details response
			const userPermissions = await permissions.getPermissions(roles, tenantCode, organizationCode)
			const requestedUserExtensionImage = requestedUserExtension.image
				? await utils.getDownloadableUrl(requestedUserExtension.image)
				: null

			// Construct the final details response
			const finalDetailsResponse = {
				user_id: id, // Add user_id to match mentor read
				...processDbResponse,
				visible_to_organizations: requestedUserExtension.visible_to_organizations, // Add to match mentor read
				settings: requestedUserExtension.settings, // Add settings to match mentor read
				image: requestedUserExtensionImage, // Keep original image (may already be downloadable URL)
				displayProperties,
				Permissions: userPermissions,
			}

			// Cache the complete details response
			try {
				let cacheCopy = { ...finalDetailsResponse }
				delete cacheCopy.connection_details
				delete cacheCopy.image
				delete cacheCopy.is_connected

				if (finalDetailsResponse.is_mentor) {
					await cacheHelper.mentor.set(tenantCode, id, cacheCopy)
				} else {
					await cacheHelper.mentee.set(tenantCode, id, cacheCopy)
				}
			} catch (cacheError) {
				console.error(`❌ Failed to cache mentee details ${id}:`, cacheError)
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'PROFILE_FTECHED_SUCCESSFULLY',
				result: finalDetailsResponse,
			})
		} catch (error) {
			return error
		}
	}

	/**
	 * Resolves an external user ID to an internal user ID using the communication helper.
	 * Returns a success response with the resolved user ID if successful,
	 * or a failure response if the token is unauthorized or not found.
	 *
	 * @async
	 * @static
	 * @function externalMapping
	 * @param {Object} body - The request payload containing the external user ID.
	 * @param {string} body.external_user_id - The external user identifier to resolve.
	 * @returns {Promise<Object>} A standardized success or failure response object.
	 *
	 * @example
	 * const response = await ClassName.externalMapping({ external_user_id: 'abc-123' });
	 * // response => { statusCode: 200, message: 'COMMUNICATION_TOKEN_FETCHED_SUCCESSFULLY', result: 'internal-user-id' }
	 */
	static async externalMapping(body, tenantCode) {
		try {
			const userId = await communicationHelper.resolve(body.external_user_id, tenantCode)

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'COMMUNICATION_MAPPING_FETCHED_SUCCESSFULLY',
				result: userId,
			})
		} catch (error) {
			if (error.message == 'unauthorized') {
				return responses.failureResponse({
					statusCode: httpStatusCode.not_found,
					message: 'COMMUNICATION_TOKEN_NOT_FOUND',
					responseCode: 'CLIENT_ERROR',
				})
			}
		}
	}
}
