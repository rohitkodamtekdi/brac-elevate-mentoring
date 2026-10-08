// Dependencies
const utils = require('@generics/utils')
const userRequests = require('@requests/user')
const common = require('@constants/common')
const httpStatusCode = require('@generics/http-status')
const mentorQueries = require('@database/queries/mentorExtension')
const menteeQueries = require('@database/queries/userExtension')
const { UniqueConstraintError } = require('sequelize')
const _ = require('lodash')
const sessionAttendeesQueries = require('@database/queries/sessionAttendees')
const sessionQueries = require('@database/queries/sessions')
const schedulerRequest = require('@requests/scheduler')
const entityTypeQueries = require('@database/queries/entityType')
const entityTypeCache = require('@helpers/entityTypeCache')
const organisationExtensionQueries = require('@database/queries/organisationExtension')
const orgAdminService = require('@services/org-admin')
const { getDefaults } = require('@helpers/getDefaultOrgId')
const { Op } = require('sequelize')
const { removeDefaultOrgEntityTypes } = require('@generics/utils')
const moment = require('moment')
const menteesService = require('@services/mentees')
const entityTypeService = require('@services/entity-type')
const responses = require('@helpers/responses')
const permissions = require('@helpers/getPermissions')
const { buildSearchFilter } = require('@helpers/search')
const defaultSearchConfig = require('@configs/search.json')
const emailEncryption = require('@utils/emailEncryption')
const { defaultRulesFilter, validateDefaultRulesFilter } = require('@helpers/defaultRules')
const connectionQueries = require('@database/queries/connection')
const sessionRequestQueries = require('@database/queries/requestSessions')
const communicationHelper = require('@helpers/communications')
const searchConfig = require('@root/config.json')
const cacheHelper = require('@generics/cacheHelper')
const kafkaCommunication = require('@generics/kafka-communication')
const getOrgIdAndEntityTypes = require('@helpers/getOrgIdAndEntityTypewithEntitiesBasedOnPolicy')
module.exports = class MentorsHelper {
	/**
	 * upcomingSessions.
	 * @method
	 * @name upcomingSessions
	 * @param {String} id - user id.
	 * @param {String} page - Page No.
	 * @param {String} limit - Page size limit.
	 * @param {String} search - Search text.
	 * @returns {JSON} - mentors upcoming session details
	 */
	static async upcomingSessions(
		id,
		page,
		limit,
		search = '',
		menteeUserId,
		queryParams,
		isAMentor,
		roles,
		orgCode,
		tenantCode
	) {
		try {
			let requestedMentorExtension = false
			if (id !== '' && isAMentor !== '' && roles !== '') {
				// Try cache first, fallback to direct query
				requestedMentorExtension = await cacheHelper.mentor.get(tenantCode, id)

				if (!requestedMentorExtension) {
					return responses.failureResponse({
						statusCode: httpStatusCode.bad_request,
						message: 'MENTORS_NOT_FOUND',
						responseCode: 'CLIENT_ERROR',
					})
				}
			}
			const query = utils.processQueryParametersWithExclusions(queryParams)
			const sessionModelName = await sessionQueries.getModelName()

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
			const policyOrgs = await getOrgIdAndEntityTypes.getOrganizationIdBasedOnPolicy(
				menteeUserId,
				orgCode,
				common.SESSION,
				tenantCode
			)
			const sessionOrgCodes =
				policyOrgs?.result?.organizationCodes?.length > 0 ? policyOrgs.result.organizationCodes : [orgCode]

			let validationData = await entityTypeCache.getEntityTypesAndEntitiesWithCache(
				{
					status: common.ACTIVE_STATUS,
					allow_filtering: true,
					model_names: { [Op.contains]: [sessionModelName] },
				},
				tenantCode,
				sessionOrgCodes,
				sessionModelName
			)

			if (!orgCode) {
				return responses.failureResponse({
					message: 'ORGANIZATION_CODE_REQUIRED',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			const defaultRuleFilter = await defaultRulesFilter({
				ruleType: common.DEFAULT_RULES.SESSION_TYPE,
				requesterId: menteeUserId,
				roles: roles,
				requesterOrganizationCode: orgCode,
				tenantCode: tenantCode,
			})

			if (defaultRuleFilter.error && defaultRuleFilter.error.missingField) {
				return responses.failureResponse({
					message: 'PROFILE_NOT_UPDATED',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			const filteredQuery = utils.validateAndBuildFilters(query, validationData, sessionModelName)

			// Filter upcoming sessions based on saas policy
			const saasFilter = await menteesService.filterSessionsBasedOnSaasPolicy(
				menteeUserId,
				isAMentor,
				tenantCode,
				orgCode
			)

			let upcomingSessions = await sessionQueries.getMentorsUpcomingSessionsFromView(
				page,
				limit,
				search,
				id,
				filteredQuery,
				tenantCode,
				saasFilter,
				defaultRuleFilter,
				menteeUserId
			)

			if (!upcomingSessions || !upcomingSessions.data || !upcomingSessions.data.length) {
				return responses.successResponse({
					statusCode: httpStatusCode.ok,
					message: 'UPCOMING_SESSION_FETCHED',
					result: {
						data: [],
						count: upcomingSessions ? upcomingSessions.count || 0 : 0,
					},
				})
			}

			// Process entity types to add value labels.
			const uniqueOrgIds =
				upcomingSessions && upcomingSessions.data && Array.isArray(upcomingSessions.data)
					? [...new Set(upcomingSessions.data.map((obj) => obj.mentor_organization_id))]
					: []
			upcomingSessions.data = await entityTypeService.processEntityTypesToAddValueLabels(
				upcomingSessions.data,
				uniqueOrgIds,
				common.sessionModelName,
				'mentor_organization_id',
				[],
				tenantCode,
				true
			)

			upcomingSessions.data = await this.sessionMentorDetails(upcomingSessions.data, tenantCode)

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'UPCOMING_SESSION_FETCHED',
				result: upcomingSessions,
			})
		} catch (err) {
			return err
		}
	}

	/**
	 * Profile.
	 * @method
	 * @name profile
	 * @param {String} userId - user id.
	 * @returns {JSON} - profile details
	 */
	/* 	static async profile(id) {
		try {
			const mentorsDetails = await userRequests.fetchUserDetails('', id)
			if (mentorsDetails.data.result.isAMentor && mentorsDetails.data.result.deleted === false) {
				const _id = mentorsDetails.data.result._id
				const filterSessionAttended = { userId: _id, isSessionAttended: true }
				const totalSessionsAttended = await sessionAttendees.countAllSessionAttendees(filterSessionAttended)
				const filterSessionHosted = { userId: _id, status: 'completed', isStarted: true, delete: false }
				const totalSessionHosted = await sessionsData.findSessionHosted(filterSessionHosted)
				return responses.successResponse({
					statusCode: httpStatusCode.ok,
					message: 'PROFILE_FTECHED_SUCCESSFULLY',
					result: {
						sessionsAttended: totalSessionsAttended,
						sessionsHosted: totalSessionHosted,
						...mentorsDetails.data.result,
					},
				})
			} else {
				return responses.failureResponse({
					statusCode: httpStatusCode.bad_request,
					message: 'MENTORS_NOT_FOUND',
					responseCode: 'CLIENT_ERROR',
				})
			}
		} catch (err) {
			return err
		}
	} */

	/**
	 * Mentors reports.
	 * @method
	 * @name reports
	 * @param {String} userId - user id.
	 * @param {String} filterType - MONTHLY/WEEKLY/QUARTERLY.
	 * @returns {JSON} - Mentors reports
	 */

	static async reports(userId, filterType, roles, tenantCode, scope, filters = {}) {
		try {
			if (!utils.isAMentor(roles)) {
				return responses.failureResponse({
					statusCode: httpStatusCode.bad_request,
					message: 'MENTORS_NOT_FOUND',
					responseCode: 'CLIENT_ERROR',
				})
			}

			// Dashboard scope numbers of the Support Provider (needed, committed, approved, delivered)
			if (scope) {
				const [needed, userExtension, approvedRows, deliveredRows, assetRequests, publishedAssets] =
					await Promise.all([
						sessionRequestQueries.getOpenRequestsCount(tenantCode, filters),
						menteeQueries.getMenteeExtension(userId, ['meta'], false, tenantCode),
						sessionRequestQueries.getAcceptedRequestsSeatsCount(userId, tenantCode, filters),
						sessionRequestQueries.getAcceptedRequestsDeliveredCount(userId, tenantCode, filters),
						sessionRequestQueries.getAssetRequestsValues(userId, tenantCode),
						sessionQueries.getPublishedAssetsValue(userId, tenantCode),
					])

				// Total Asset Pool = Published Assets Value - (Delivered + Approved + Pending Requests Value)
				// TODO: Delivered value is kept out of the pool for now, uncomment once finalised
				const assets = {
					...assetRequests,
					published: publishedAssets,
					pool: publishedAssets.value - (assetRequests.approved.value + assetRequests.pending.value),
					// pool:
					// 	publishedAssets.value -
					// 	(assetRequests.delivered.value + assetRequests.approved.value + assetRequests.pending.value),
				}

				// Commitments are entity types of UserExtension, stored in meta as entered on the profile
				const meta = userExtension?.meta || {}
				const toNumber = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)
				const sessionsCommitted = toNumber(meta.sessions_committed)
				const servicesCommitted = toNumber(meta.services_committed)
				const assetsCommitted = toNumber(meta.assets_committed)
				const sum = (counts) => Object.values(counts).reduce((total, count) => total + count, 0)
				const approved = sessionRequestQueries.countsByCategory(approvedRows)
				const delivered = sessionRequestQueries.countsByCategory(deliveredRows)

				// Delivered per province, for every province the SP has accepted requests in
				const provinces = {}
				approvedRows.forEach((row) => {
					if (row.province_id) provinces[row.province_id] = { delivered: 0 }
				})
				deliveredRows.forEach((row) => {
					if (!row.province_id) return
					provinces[row.province_id] = provinces[row.province_id] || { delivered: 0 }
					provinces[row.province_id].delivered += row.count
				})

				// Committed of each support category comes from its own commitment entity type
				const committedByCategory = {
					training: sessionsCommitted,
					additional_service: servicesCommitted,
					asset: assetsCommitted,
				}
				// Commitments are not captured per province or site, so committed is null when either filter is applied
				const isLocationFiltered = Boolean(filters.province || filters.site)
				const categories = Object.keys(committedByCategory).reduce((acc, category) => {
					acc[category] = {
						needed: needed[category],
						committed: isLocationFiltered ? null : committedByCategory[category],
						approved: approved[category],
						delivered: delivered[category],
					}
					return acc
				}, {})
				let committed = sessionsCommitted + servicesCommitted
				if (isLocationFiltered) committed = null
				else if (filters.type) committed = committedByCategory[filters.type] ?? 0

				return responses.successResponse({
					statusCode: httpStatusCode.ok,
					message: 'DASHBOARD_SCOPE_FETCHED_SUCCESSFULLY',
					result: {
						needed: sum(needed),
						committed,
						approved: sum(approved),
						delivered: sum(delivered),
						commitments: {
							sessions_committed: sessionsCommitted,
							services_committed: servicesCommitted,
							assets_committed: assetsCommitted,
						},
						categories,
						provinces,
						assets,
					},
				})
			}

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

			const totalSessionsCreated = await sessionQueries.getCreatedSessionsCountInDateRange(
				userId,
				filterStartDate.toISOString(),
				filterEndDate.toISOString(),
				tenantCode
			)

			const totalSessionsAssigned = await sessionQueries.getAssignedSessionsCountInDateRange(
				userId,
				filterStartDate.toISOString(),
				filterEndDate.toISOString(),
				tenantCode
			)

			const totalSessionsHosted = await sessionQueries.getHostedSessionsCountInDateRange(
				userId,
				Date.parse(filterStartDate) / 1000, // Converts milliseconds to seconds
				Date.parse(filterEndDate) / 1000,
				tenantCode
			)

			const result = {
				total_session_created: totalSessionsCreated,
				total_session_hosted: totalSessionsHosted,
				total_session_assigned: totalSessionsAssigned,
			}
			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'MENTORS_REPORT_FETCHED_SUCCESSFULLY',
				result,
			})
		} catch (error) {
			throw error
		}
	}

	/**
	 * Shareable mentor profile link.
	 * @method
	 * @name share
	 * @param {String} _id - Mentors user id.
	 * @returns {JSON} - Returns sharable link of the mentor.
	 */
	static async share(id, userId, organizationCode, tenantCode) {
		try {
			// Try cache first using logged-in user's organization context
			let mentorsDetails = await cacheHelper.mentor.get(tenantCode, id)
			if (!mentorsDetails) {
				return responses.failureResponse({
					statusCode: httpStatusCode.bad_request,
					message: 'MENTORS_NOT_FOUND',
					responseCode: 'CLIENT_ERROR',
				})
			}
			const shareLink = await userRequests.share(id)
			return shareLink
		} catch (error) {
			return error
		}
	}

	static async sessionMentorDetails(session, tenantCode) {
		try {
			if (session.length > 0) {
				const userIds = _.uniqBy(session, 'mentor_id').map((item) => item.mentor_id)

				let mentorDetails = await userRequests.getUserDetailedListUsingCache(userIds, tenantCode)

				mentorDetails = mentorDetails.result

				for (let i = 0; i < session.length; i++) {
					let mentorIndex = mentorDetails.findIndex((x) => x.user_id === session[i].mentor_id)

					session[i].mentor_name = mentorDetails[mentorIndex].name
					session[i].organization = mentorDetails[mentorIndex].organization
				}

				await Promise.all(
					session.map(async (sessions) => {
						if (sessions.image && sessions.image.length > 0) {
							sessions.image = sessions.image.map(async (imgPath) => {
								if (imgPath && imgPath != '') {
									return await utils.getDownloadableUrl(imgPath)
								}
							})
							sessions.image = await Promise.all(sessions.image)
						}
					})
				)

				return session
			} else {
				return session
			}
		} catch (error) {
			throw error
		}
	}

	static async menteeSessionDetails(sessions, userId, tenantCode) {
		try {
			if (sessions.length > 0) {
				const sessionIds = sessions.map((session) => session.id).filter((id) => id != null)

				if (sessionIds.length === 0) {
					return sessions
				}

				const attendees = await sessionAttendeesQueries.findAll(
					{
						session_id: sessionIds,
						mentee_id: userId,
					},
					tenantCode
				)

				await Promise.all(
					sessions.map(async (session) => {
						const attendee = attendees.find((attendee) => attendee.session_id === session.id)
						session.is_enrolled = !!attendee
						session.enrolment_type = attendee?.type
					})
				)

				const filteredSessions = sessions.filter((session) => {
					return (
						session.type === common.SESSION_TYPE.PUBLIC ||
						(session.type === common.SESSION_TYPE.PRIVATE && session.is_enrolled)
					)
				})

				return filteredSessions
			} else {
				return sessions
			}
		} catch (err) {
			return err
		}
	}

	//Functions for new APIS
	/**
	 * Create a new mentor extension.
	 * @method
	 * @name createMentorExtension
	 * @param {Object} data - Mentor extension data to be created.
	 * @param {String} userId - User ID of the mentor.
	 * @returns {Promise<Object>} - Created mentor extension details.
	 */
	static async createMentorExtension(data, userId, orgCode, tenantCode, orgId) {
		try {
			let skipValidation = data.skipValidation ? data.skipValidation : false
			if (data.email) {
				data.email = emailEncryption.encrypt(data.email.toLowerCase())
			}
			// Use organization code as temporary name and let findOrInsertOrganizationExtension handle creation
			const organization_name = orgCode // Temporary fallback, can be updated later

			// Find organisation policy from organisation_extension table
			let organisationPolicy = await organisationExtensionQueries.findOrInsertOrganizationExtension(
				orgId,
				orgCode,
				organization_name,
				tenantCode
			)

			// Cache the organization extension result
			if (organisationPolicy && organisationPolicy.organization_code && organisationPolicy.organization_id) {
				cacheHelper.organizations
					.set(
						tenantCode,
						organisationPolicy.organization_code,
						organisationPolicy.organization_id,
						organisationPolicy
					)
					.catch((cacheError) => {
						console.error(
							`❌ Failed to cache organization ${organisationPolicy.organization_id} in mentor create:`,
							cacheError
						)
					})
			}

			data.user_id = userId
			data.organization_code = orgCode

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
			const mentorExtensionsModelName = await mentorQueries.getModelName()

			let entityTypes = await entityTypeCache.getEntityTypesAndEntitiesForModel(
				mentorExtensionsModelName,
				tenantCode,
				orgCode
			)
			if (entityTypes instanceof Error) {
				throw entityTypes
			}

			//validationData = utils.removeParentEntityTypes(JSON.parse(JSON.stringify(validationData)))
			const validationData = removeDefaultOrgEntityTypes(entityTypes, orgCode)
			let res = utils.validateInput(data, validationData, mentorExtensionsModelName, skipValidation)
			if (!res.success) {
				return responses.failureResponse({
					message: 'SESSION_CREATION_FAILED',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
					result: res.errors,
				})
			}
			let mentorExtensionsModel = await mentorQueries.getColumns()
			data = utils.restructureBody(data, validationData, mentorExtensionsModel)

			// construct saas policy data
			let saasPolicyData = await orgAdminService.constructOrgPolicyObject(organisationPolicy, true)

			// Set related_orgs to include current organization
			const related_orgs = [saasPolicyData.organization_id]

			// update mentee extension data
			data = {
				...data,
				...saasPolicyData,
				visible_to_organizations: related_orgs,
			}
			const response = await mentorQueries.createMentorExtension(data, tenantCode)

			const processDbResponse = utils.processDbResponse(response.toJSON(), validationData)

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'MENTOR_EXTENSION_CREATED',
				result: processDbResponse,
			})
		} catch (error) {
			if (error instanceof UniqueConstraintError) {
				return responses.failureResponse({
					message: 'MENTOR_EXTENSION_CREATION_FAILED',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}
			return error
		}
	}

	/**
	 * Update a mentor extension.
	 * @method
	 * @name updateMentorExtension
	 * @param {String} userId - User ID of the mentor.
	 * @param {Object} data - Updated mentor extension data excluding user_id.
	 * @returns {Promise<Object>} - Updated mentor extension details.
	 */
	static async updateMentorExtension(data, userId, orgCode, tenantCode) {
		try {
			// Try cache first for current mentor data
			let currentUser = await cacheHelper.mentor.get(tenantCode, userId)
			if (!currentUser) {
				return responses.failureResponse({
					statusCode: httpStatusCode.not_found,
					message: 'MENTOR_EXTENSION_NOT_FOUND',
				})
			}
			if (data.email) data.email = emailEncryption.encrypt(data.email.toLowerCase())
			let skipValidation = data.skipValidation ? data.skipValidation : false
			// Remove certain data in case it is getting passed
			const dataToRemove = [
				'user_id',
				'mentor_visibility',
				'mentee_visibility',
				'visible_to_organizations',
				'external_session_visibility',
				'external_mentor_visibility',
				'external_mentee_visibility',
			]

			dataToRemove.forEach((key) => {
				if (data[key]) {
					delete data[key]
				}
			})

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
			const mentorExtensionsModelName = await mentorQueries.getModelName()

			let entityTypes = await entityTypeCache.getEntityTypesAndEntitiesForModel(
				mentorExtensionsModelName,
				tenantCode,
				orgCode
			)
			if (entityTypes instanceof Error) {
				throw entityTypes
			}
			const validationData = removeDefaultOrgEntityTypes(entityTypes, defaults.orgCode)
			let mentorExtensionsModel = await mentorQueries.getColumns()

			let res = utils.validateInput(data, validationData, mentorExtensionsModelName, skipValidation)
			if (!res.success) {
				return responses.failureResponse({
					message: 'PROFILE_UPDATE_FAILED',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
					result: res.errors,
				})
			}

			data = utils.restructureBody(data, validationData, mentorExtensionsModel)

			if (data?.organization?.id) {
				//Do a org policy update for the user only if the data object explicitly includes an
				//organization.id. This is added for the users/update workflow where
				//both both user data and organisation can change at the same time.
				let userOrgDetails = await userRequests.fetchOrgDetails({ organizationCode: orgCode, tenantCode })
				const orgPolicies = await organisationExtensionQueries.findOrInsertOrganizationExtension(
					data.organization.id,
					orgCode,
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
				data.organization_id = data.organization.id
				const newPolicy = await orgAdminService.constructOrgPolicyObject(orgPolicies, true)
				data = _.merge({}, data, newPolicy)
				data.visible_to_organizations = Array.from(
					new Set([...userOrgDetails.data.result.related_orgs, data.organization.id])
				)
			}

			const [updateCount, updatedMentor] = await mentorQueries.updateMentorExtension(
				userId,
				data,
				{
					returning: true,
					raw: true,
				},
				{},
				false,
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
				let fallbackUpdatedUser = await cacheHelper.mentor.get(tenantCode, userId)
				if (!fallbackUpdatedUser) {
					return responses.failureResponse({
						statusCode: httpStatusCode.not_found,
						message: 'MENTOR_EXTENSION_NOT_FOUND',
					})
				}

				const processDbResponse = utils.processDbResponse(fallbackUpdatedUser, validationData)
				return responses.successResponse({
					statusCode: httpStatusCode.ok,
					message: 'MENTOR_EXTENSION_UPDATED',
					result: processDbResponse,
				})
			}

			//validationData = utils.removeParentEntityTypes(JSON.parse(JSON.stringify(validationData)))

			const processDbResponse = utils.processDbResponse(updatedMentor[0], validationData)

			// Delete old cache and cache the new updated data
			if (userId && orgCode) {
				try {
					// Delete old cache first
					await cacheHelper.mentor.delete(tenantCode, userId)
				} catch (cacheError) {
					console.error(`❌ Failed to update mentor cache after update:`, cacheError)
				}
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'MENTOR_EXTENSION_UPDATED',
				result: processDbResponse,
			})
		} catch (error) {
			return error
		}
	}

	/**
	 * Get mentor extension details by user ID.
	 * @method
	 * @name getMentorExtension
	 * @param {String} userId - User ID of the mentor.
	 * @param {String} organizationCode - Organization code from token context.
	 * @returns {Promise<Object>} - Mentor extension details.
	 */
	static async getMentorExtension(userId, tenantCode) {
		try {
			// Try cache first using logged-in user's organization context
			let mentor = await cacheHelper.mentor.get(tenantCode, userId)
			if (!mentor) {
				return responses.failureResponse({
					statusCode: httpStatusCode.not_found,
					message: 'MENTOR_EXTENSION_NOT_FOUND',
				})
			}

			// We already have mentor data from the initial cache call, no need to fetch again
			if (mentor.is_mentor) {
				// Always generate fresh downloadable URL for image (cached URLs expire)
				if (mentor.image) {
					try {
						mentor.image = await utils.getDownloadableUrl(mentor.image)
					} catch (error) {
						console.error(`Failed to get downloadable URL for cached mentor image:`, error)
						mentor.image = null
					}
				}

				return responses.successResponse({
					statusCode: httpStatusCode.ok,
					message: 'MENTOR_EXTENSION_FETCHED',
					result: mentor,
				})
			}

			// Try mentee cache as fallback (user might have both roles)
			const cachedUser = await cacheHelper.mentee.get(tenantCode, userId)
			if (cachedUser) {
				// Always generate fresh downloadable URL for image (cached URLs expire)
				if (cachedUser.image) {
					try {
						cachedUser.image = await utils.getDownloadableUrl(cachedUser.image)
					} catch (error) {
						console.error(`Failed to get downloadable URL for cached user image:`, error)
						cachedUser.image = null
					}
				}

				return responses.successResponse({
					statusCode: httpStatusCode.ok,
					message: 'MENTOR_EXTENSION_FETCHED',
					result: cachedUser,
				})
			}

			// Cache miss - get full profile from user service
			const user = await userRequests.getProfileDetails({ tenantCode, userId })
			if (user.statusCode === httpStatusCode.ok && user.result) {
				const userResponse = {
					...user.result,
					...mentor,
				}

				return responses.successResponse({
					statusCode: httpStatusCode.ok,
					message: 'MENTOR_EXTENSION_FETCHED',
					result: userResponse,
				})
			}

			// Fallback to just extension data if user service fails
			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'MENTOR_EXTENSION_FETCHED',
				result: mentor,
			})
		} catch (error) {
			return error
		}
	}

	/**
	 * Delete a mentor extension by user ID.
	 * @method
	 * @name deleteMentorExtension
	 * @param {String} userId - User ID of the mentor.
	 * @returns {Promise<Object>} - Indicates if the mentor extension was deleted successfully.
	 */
	static async deleteMentorExtension(userId, tenantCode) {
		try {
			// Get mentor extension before deletion to retrieve organization_code for cache deletion
			const mentorExtension = await mentorQueries.getMentorExtension(
				userId,
				['organization_code'],
				false,
				tenantCode
			)

			const deleteCount = await mentorQueries.deleteMentorExtension(userId, tenantCode, false)
			if (deleteCount === '0') {
				return responses.failureResponse({
					statusCode: httpStatusCode.not_found,
					message: 'MENTOR_EXTENSION_NOT_FOUND',
				})
			}

			// Cache invalidation: Clear mentor cache after deletion
			if (mentorExtension && mentorExtension.organization_code) {
				try {
					await cacheHelper.mentor.delete(tenantCode, userId)
				} catch (cacheError) {
					console.error(`Cache deletion failed for mentor ${userId}:`, cacheError)
				}
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'MENTOR_EXTENSION_DELETED',
			})
		} catch (error) {
			return error
		}
	}

	/**
	 * Read.
	 * @method
	 * @name read
	 * @param {Number} id 						- mentor id.
	 * @param {Number} orgId 					- org id
	 * @param {Number} userId 					- User id.
	 * @param {Boolean} isAMentor 				- user mentor or not.
	 * @returns {JSON} 							- profile details
	 */
	static async read(id, orgCode, userId = '', isAMentor = '', roles = '', tenantCode) {
		try {
			let cachedProfile = await cacheHelper.mentor.getCacheOnly(tenantCode, id)

			// If we have cached data, use it efficiently
			if (cachedProfile) {
				let requestedMentorExtension = false
				if (userId !== '' && isAMentor !== '' && roles !== '') {
					// Use cached data for validation instead of making redundant database query
					requestedMentorExtension = cachedProfile

					const validateDefaultRules = await validateDefaultRulesFilter({
						ruleType: common.DEFAULT_RULES.MENTOR_TYPE,
						requesterId: userId,
						roles: roles,
						requesterOrganizationCode: orgCode,
						data: requestedMentorExtension,
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
							message: 'MENTORS_NOT_FOUND',
							statusCode: httpStatusCode.bad_request,
							responseCode: 'CLIENT_ERROR',
						})
					}
					// Throw error if extension not found
					if (!requestedMentorExtension || Object.keys(requestedMentorExtension).length === 0) {
						return responses.failureResponse({
							statusCode: httpStatusCode.not_found,
							message: 'MENTORS_NOT_FOUND',
						})
					}

					// Check for accessibility for reading shared mentor profile
					const isAccessible = await this.checkIfMentorIsAccessible(
						[requestedMentorExtension],
						userId,
						isAMentor,
						tenantCode,
						orgCode
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
					cachedProfile.is_connected = Boolean(connection)

					if (cachedProfile.is_connected) {
						cachedProfile.connection_details = connection.meta
					}
				}

				// Always generate fresh downloadable URL for image (cached URLs expire)
				if (cachedProfile.image) {
					try {
						cachedProfile.image = await utils.getDownloadableUrl(cachedProfile.image)
					} catch (error) {
						console.error(`Failed to get downloadable URL for cached profile image:`, error)
					}
				}

				if (cachedProfile?.meta?.communications_user_id) {
					try {
						const chat = await communicationHelper.login(id, tenantCode)

						cachedProfile.meta = {
							...cachedProfile.meta,
							chat,
						}
					} catch (error) {}
				}

				return responses.successResponse({
					statusCode: httpStatusCode.ok,
					message: 'PROFILE_FETCHED_SUCCESSFULLY',
					result: cachedProfile,
				})
			}

			// Get mentor extension data efficiently (avoid redundant queries)
			let mentorExtension = await cacheHelper.mentor.get(tenantCode, id)
			if (!mentorExtension) {
				return responses.failureResponse({
					statusCode: httpStatusCode.not_found,
					message: 'MENTORS_NOT_FOUND',
				})
			}

			// If user authentication is required, perform validation
			if (userId !== '' && isAMentor !== '' && roles !== '') {
				const validateDefaultRules = await validateDefaultRulesFilter({
					ruleType: common.DEFAULT_RULES.MENTOR_TYPE,
					requesterId: userId,
					roles: roles,
					requesterOrganizationCode: orgCode,
					data: mentorExtension,
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
						message: 'MENTORS_NOT_FOUND',
						statusCode: httpStatusCode.bad_request,
						responseCode: 'CLIENT_ERROR',
					})
				}
				// Throw error if extension not found
				if (!mentorExtension || Object.keys(mentorExtension).length === 0) {
					return responses.failureResponse({
						statusCode: httpStatusCode.not_found,
						message: 'MENTORS_NOT_FOUND',
					})
				}

				// Check for accessibility for reading shared mentor profile
				const isAccessible = await this.checkIfMentorIsAccessible(
					[mentorExtension],
					userId,
					isAMentor,
					tenantCode,
					orgCode
				)

				// Throw access error
				if (!isAccessible) {
					return responses.failureResponse({
						statusCode: httpStatusCode.forbidden,
						message: 'PROFILE_RESTRICTED',
					})
				}
			}

			mentorExtension = utils.deleteProperties(mentorExtension, ['created_at', 'updated_at'])

			mentorExtension = utils.deleteProperties(mentorExtension, ['phone'])

			const mentorOrgCode = mentorExtension.organization_code
			const mentorExtensionsModelName = await mentorQueries.getModelName()

			let entityTypes = await entityTypeCache.getEntityTypesAndEntitiesForModel(
				mentorExtensionsModelName,
				tenantCode,
				mentorOrgCode
			)
			if (entityTypes instanceof Error) {
				throw entityTypes
			}

			// validationData = utils.removeParentEntityTypes(JSON.parse(JSON.stringify(validationData)))
			const validationData = removeDefaultOrgEntityTypes(entityTypes, mentorOrgCode)

			const processDbResponse = utils.processDbResponse(mentorExtension, validationData)
			const totalSessionHosted = await sessionQueries.countHostedSessions(id, tenantCode)

			// Try to get display properties from cache (with tenant/org fallback)
			let displayProperties = await cacheHelper.displayProperties.get(tenantCode, orgCode)

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

				// Cache at org level
				try {
					await cacheHelper.displayProperties.set(tenantCode, orgCode, displayProperties)
				} catch (cacheError) {
					console.error(`❌ Failed to cache display properties:`, cacheError)
				}
			}

			const mentorPermissions = await permissions.getPermissions(roles, tenantCode, orgCode)

			// Add is_connected field - check connection if userId is provided (viewing others' profile)
			if (userId !== '') {
				const connection = await connectionQueries.getConnection(userId, id, tenantCode)
				processDbResponse.is_connected = Boolean(connection)

				if (processDbResponse.is_connected) {
					processDbResponse.connection_details = connection.meta
				}
			} else {
				// For own profile read or when no userId provided
				processDbResponse.is_connected = false
			}

			if (!Array.isArray(mentorExtension.permissions)) {
				mentorExtension.permissions = []
			}

			// Handle both array response (success) and response object (error)
			if (Array.isArray(mentorPermissions)) {
				mentorExtension.permissions.push(...mentorPermissions)
			} else {
				// It's the error response object, extract the permissions array
				const permissionsArray = mentorPermissions.result?.permissions || []
				mentorExtension.permissions.push(...permissionsArray)
			}

			let communications = null

			if (mentorExtension?.meta?.communications_user_id) {
				try {
					const chat = await communicationHelper.login(id, tenantCode)
					communications = chat
				} catch (error) {}
			}
			processDbResponse.meta = {
				...processDbResponse.meta,
				communications,
			}

			if (!mentorExtension.organization) {
				// Get organization details with cache-first approach
				let orgDetails = null

				// Try cache first if we have organization_id
				try {
					if (mentorExtension.organization_id) {
						orgDetails = await cacheHelper.organizations.get(
							tenantCode,
							mentorOrgCode,
							mentorExtension.organization_id
						)
					}
				} catch (cacheError) {
					console.warn('Organization cache lookup failed, falling back to database')
				}

				// Fallback to database if cache miss
				if (!orgDetails) {
					orgDetails = await organisationExtensionQueries.findOne(
						{ organization_code: mentorOrgCode },
						tenantCode,
						{
							attributes: ['name', 'organization_id', 'organization_code'],
						}
					)
				}

				mentorExtension['organization'] = {
					id: mentorOrgCode,
					name: orgDetails?.name,
				}
			}

			// Add profile_mandatory_fields
			const profileMandatoryFieldsRead = await utils.validateProfileData(processDbResponse, validationData)
			processDbResponse.profile_mandatory_fields = profileMandatoryFieldsRead

			// Construct the final profile response (INCLUDE sessions_attended for read endpoint)
			const totalSessionsAttended = await sessionAttendeesQueries.countEnrolledSessions(id, tenantCode)

			const mentorImage = mentorExtension.image ? await utils.getDownloadableUrl(mentorExtension.image) : null
			const finalProfile = {
				user_id: id, // Add user_id to match mentee read response
				...mentorExtension,
				...processDbResponse,
				meta: {
					...(processDbResponse.meta || {}),
				},
				sessions_hosted: totalSessionHosted,
				visible_to_organizations: mentorExtension.visible_to_organizations, // Add to match mentee read
				settings: mentorExtension.settings, // Add settings to match mentee read
				image: mentorImage, // Keep original image (may already be downloadable URL)
				sessions_attended: totalSessionsAttended, // Add sessions_attended
				profile_mandatory_fields: processDbResponse.profile_mandatory_fields, // Ensure not overwritten
				organization: mentorExtension.organization, // Ensure not overwritten
				displayProperties,
			}

			try {
				const cacheCopy = { ...finalProfile }
				delete cacheCopy.image
				delete cacheCopy.is_connected
				delete cacheCopy.connection_details
				delete cacheCopy.meta?.communications
				console.log(`💾 Caching complete mentor profile response for ${id}`)
				await cacheHelper.mentor.set(tenantCode, id, cacheCopy)
			} catch (cacheError) {
				console.error(`❌ Failed to cache mentor profile ${id}:`, cacheError)
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'PROFILE_FETCHED_SUCCESSFULLY',
				result: finalProfile,
			})
		} catch (error) {
			return error
		}
	}

	/**
	 * Get user policy details from cache or database
	 * @method
	 * @name _getUserPolicyDetails
	 * @param {Boolean} isAMentor - Whether user is a mentor
	 * @param {String} tenantCode - Tenant code
	 * @param {String} orgCode - Organization code
	 * @param {String} userId - User ID
	 * @returns {Object|null} - User policy details
	 */
	static async _getUserPolicyDetails(isAMentor, tenantCode, orgCode, userId) {
		const cacheKey = isAMentor ? 'mentor' : 'mentee'
		const queryFunction = isAMentor ? mentorQueries.getMentorExtension : menteeQueries.getMenteeExtension

		// Try cache first
		let userPolicyDetails = await cacheHelper[cacheKey].getCacheOnly(tenantCode, userId)

		// Fallback to database query if cache miss
		if (!userPolicyDetails) {
			userPolicyDetails = await queryFunction(
				userId,
				['external_mentor_visibility', 'organization_id'],
				false,
				tenantCode
			)
		}

		return userPolicyDetails
	}

	/**
	 * @description 							- check if mentor is accessible based on user's saas policy.
	 * @method
	 * @name checkIfMentorIsAccessible
	 * @param {Number} userId 					- User id.
	 * @param {Array}							- Session data
	 * @param {Boolean} isAMentor 				- user mentor or not.
	 * @returns {JSON} 							- List of filtered sessions
	 */
	static async checkIfMentorIsAccessible(userData, userId, isAMentor, tenantCode, orgCode) {
		try {
			// Get user policy details using helper function
			const userPolicyDetails = await this._getUserPolicyDetails(isAMentor, tenantCode, orgCode, userId)

			// Throw error if mentor/mentee extension not found
			if (!userPolicyDetails || Object.keys(userPolicyDetails).length === 0) {
				return responses.failureResponse({
					statusCode: httpStatusCode.not_found,
					message: isAMentor ? 'MENTORS_NOT_FOUND' : 'MENTEE_EXTENSION_NOT_FOUND',
					responseCode: 'CLIENT_ERROR',
				})
			}

			// check the accessibility conditions
			let isAccessible = false
			if (userPolicyDetails.external_mentor_visibility && userPolicyDetails.organization_id) {
				const { external_mentor_visibility, organization_id } = userPolicyDetails
				const mentor = userData[0]
				switch (external_mentor_visibility) {
					/**
					 * if user external_mentor_visibility is current. He can only see his/her organizations mentors
					 * so we will check mentor's organization_id and user organization_id are matching
					 */
					case common.CURRENT:
						isAccessible = mentor.organization_id === organization_id
						break
					/**
					 * If user external_mentor_visibility is associated
					 * <<point**>> first we need to check if mentor's visible_to_organizations contain the user organization_id and verify mentor's visibility is not current (if it is ALL and ASSOCIATED it is accessible)
					 */
					case common.ASSOCIATED:
						isAccessible =
							(mentor.visible_to_organizations.includes(organization_id) &&
								mentor.mentor_visibility != common.CURRENT) ||
							mentor.organization_id === organization_id
						break
					/**
					 * We need to check if mentor's visible_to_organizations contain the user organization_id and verify mentor's visibility is not current (if it is ALL and ASSOCIATED it is accessible)
					 * OR if mentor visibility is ALL that mentor is also accessible
					 */
					case common.ALL:
						isAccessible =
							(mentor.visible_to_organizations.includes(organization_id) &&
								mentor.mentor_visibility != common.CURRENT) ||
							mentor.mentor_visibility === common.ALL ||
							mentor.organization_id === organization_id
						break
					default:
						break
				}
			}
			return isAccessible
		} catch (err) {
			return err
		}
	}
	/**
	 * Get user list.
	 * @method
	 * @name create
	 * @param {Number} pageSize -  Page size.
	 * @param {Number} pageNo -  Page number.
	 * @param {String} searchText -  Search text.
	 * @param {JSON} queryParams -  Query params.
	 * @param {Boolean} isAMentor -  Is a mentor.
	 * @returns {JSON} - User list.
	 */

	static async list(
		pageNo,
		pageSize,
		searchText,
		searchOn,
		queryParams,
		userId,
		isAMentor,
		roles,
		orgCode,
		tenantCode
	) {
		try {
			let additionalProjectionString = ''
			let userServiceQueries = {}

			// check for fields query (Adds to the projection)
			if (queryParams.fields && queryParams.fields !== '') {
				additionalProjectionString = queryParams.fields
				delete queryParams.fields
			}

			let organization_codes = []
			let directory = false

			const [sortBy, order] = ['name'].includes(queryParams.sort_by)
				? [queryParams.sort_by, queryParams.order || 'ASC']
				: [false, 'ASC']

			for (let key in queryParams) {
				if (queryParams.hasOwnProperty(key) & ((key === 'email') | (key === 'name'))) {
					userServiceQueries[key] = queryParams[key]
				}
				if (queryParams.hasOwnProperty(key) & (key === 'organization_ids')) {
					organization_codes = queryParams[key].split(',')
				}

				if (
					queryParams.hasOwnProperty(key) &
					(key === 'directory') &
					((queryParams[key] == 'true') | (queryParams[key] == true))
				) {
					directory = true
				}
			}

			const emailIds = []
			const searchTextArray = searchText ? searchText.split(',') : []

			searchTextArray.forEach((element) => {
				if (utils.isValidEmail(element)) {
					emailIds.push(emailEncryption.encrypt(element.toLowerCase()))
				}
			})
			const hasValidEmails = emailIds.length > 0

			const query = utils.processQueryParametersWithExclusions(queryParams)
			const mentorExtensionsModelName = await mentorQueries.getModelName()
			// Note: Entity types are actually configured for UserExtension model, not MentorExtension
			const userExtensionsModelName = 'UserExtension'

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

			let validationData = await entityTypeCache.getEntityTypesAndEntitiesForModel(
				userExtensionsModelName,
				tenantCode,
				orgCode,
				{ allow_filtering: true }
			)
			const filteredQuery = utils.validateAndBuildFilters(query, validationData)

			const saasFilter = await this.filterMentorListBasedOnSaasPolicy(
				userId,
				isAMentor,
				organization_codes,
				tenantCode,
				orgCode
			)

			let search_config = defaultSearchConfig
			if (searchConfig.search) {
				search_config = { search: searchConfig.search }
			}

			let searchFilter
			if (!hasValidEmails) {
				searchFilter = await buildSearchFilter({
					searchOn: searchOn ? searchOn.split(',') : false,
					searchConfig: search_config.search.mentor,
					search: searchText,
					modelName: mentorExtensionsModelName,
					tenantCode: tenantCode,
				})

				if (!searchFilter) {
					return responses.successResponse({
						statusCode: httpStatusCode.ok,
						message: 'MENTOR_LIST',
						result: {
							data: [],
							count: 0,
						},
					})
				}
			}
			if (!orgCode) {
				return responses.failureResponse({
					message: 'ORGANIZATION_CODE_REQUIRED',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			const defaultRuleFilter = await defaultRulesFilter({
				ruleType: 'mentor',
				requesterId: queryParams.menteeId ? queryParams.menteeId : userId,
				roles: roles,
				requesterOrganizationCode: orgCode,
				tenantCode: tenantCode,
			})

			if (defaultRuleFilter.error && defaultRuleFilter.error.missingField) {
				return responses.failureResponse({
					message: 'PROFILE_NOT_UPDATED',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			let connectedMentorsIds = []

			if (queryParams.connected_mentors === 'true') {
				const connectedQueryParams = { ...queryParams }
				delete connectedQueryParams.connected_mentors
				const connectedQuery = utils.processQueryParametersWithExclusions(connectedQueryParams)

				const connectionDetails = await connectionQueries.getConnectionsDetails(
					pageNo,
					pageSize,
					connectedQuery,
					searchText,
					queryParams.mentorId ? queryParams.mentorId : userId,
					organization_codes,
					[] // roles can be passed if needed
				)

				if (connectionDetails?.data?.length > 0) {
					connectedMentorsIds = connectionDetails.data.map((item) => item.user_id)
					if (!connectedMentorsIds.includes(userId)) {
						connectedMentorsIds.push(userId)
					}
				}

				// If there are no connected mentees, short-circuit and return empty
				if (connectedMentorsIds.length === 0) {
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

			// Fetch mentor data
			let extensionDetails = await mentorQueries.getMentorsByUserIdsFromView(
				connectedMentorsIds ? connectedMentorsIds : [],
				pageNo,
				pageSize,
				filteredQuery,
				saasFilter,
				additionalProjectionString,
				false,
				searchFilter,
				hasValidEmails ? emailIds : searchText,
				defaultRuleFilter,
				tenantCode
			)
			// Early return for empty results
			if (
				!extensionDetails ||
				!extensionDetails.data ||
				!Array.isArray(extensionDetails.data) ||
				extensionDetails.count === 0 ||
				extensionDetails.data.length === 0
			) {
				return responses.successResponse({
					statusCode: httpStatusCode.ok,
					message: 'MENTOR_LIST',
					result: {
						data: [],
						count: extensionDetails.count,
					},
				})
			}

			const mentorIds = []
			const organizationCodes = []
			const uniqueOrganizations = new Map() // key: organization_code

			for (const item of extensionDetails.data) {
				// mentor ids
				mentorIds.push(item.user_id)

				// organization codes (unique)
				if (item.organization_code && !uniqueOrganizations.has(item.organization_code)) {
					organizationCodes.push(item.organization_code)

					uniqueOrganizations.set(item.organization_code, {
						organization_id: item.organization_id,
						organization_code: item.organization_code,
					})
				}
			}
			const organizations = Array.from(uniqueOrganizations.values())

			const orgMap = {}
			if (organizations.length > 0) {
				await Promise.all(
					organizations.map(async function (orgData) {
						let orgInfo = await cacheHelper.organizations.get(
							tenantCode,
							orgData.organization_code,
							orgData.organization_id
						)

						if (orgInfo && orgInfo.organization_code) {
							orgMap[orgInfo.organization_code] = {
								id: orgInfo.organization_code,
								name: orgInfo.name,
							}
						}
					})
				)
			}

			//Attach organization details and decrypt email for each user
			extensionDetails.data = await Promise.all(
				extensionDetails.data.map(async (user) => ({
					...user,
					id: user.user_id, // Add 'id' key, to be removed later
					email: user.email ? (await emailEncryption.decryptAndValidate(user.email)) || user.email : null, // Decrypt email
					organization: orgMap[user.organization_code] || null,
				}))
			)

			const connectedUsers = await connectionQueries.getConnectionsByUserIds(userId, mentorIds, tenantCode)
			const connectedMentorIds = new Set(connectedUsers.map((connectedUser) => connectedUser.friend_id))

			if (extensionDetails.data && Array.isArray(extensionDetails.data) && extensionDetails.data.length > 0) {
				// Process all entity types for UserExtension model (don't filter by specific entity types)
				extensionDetails.data = await entityTypeService.processEntityTypesToAddValueLabels(
					extensionDetails.data,
					organizationCodes,
					userExtensionsModelName, // Use UserExtension model name for entity processing
					'organization_code',
					[], // Empty array means process ALL entity types for this model
					tenantCode
				)
			}

			// Map over extensionDetails.data to merge with the corresponding userDetail
			extensionDetails.data = (
				await Promise.all(
					extensionDetails.data.map(async (extensionDetail) => {
						const isConnected = connectedMentorIds.has(extensionDetail.user_id)

						// Merge userDetail with extensionDetail, prioritize extensionDetail properties
						let userDetail = { ...extensionDetail, is_connected: isConnected }
						if (userDetail.image && userDetail.image !== '') {
							try {
								userDetail.image = await utils.getDownloadableUrl(userDetail.image)
							} catch (error) {
								console.error('Failed to get downloadable URL for mentor image:', error)
								userDetail.image = null
							}
						}
						delete userDetail.user_id
						delete userDetail.mentor_visibility
						delete userDetail.mentee_visibility
						delete userDetail.meta
						return userDetail
					})
				)
			).filter((extensionDetail) => extensionDetail !== null)
			if (directory) {
				let foundKeys = {}
				let result = []
				for (let user of extensionDetails.data) {
					let firstChar = user.name.charAt(0)
					firstChar = firstChar.toUpperCase()

					if (!foundKeys[firstChar]) {
						result.push({
							key: firstChar,
							values: [user],
						})
						foundKeys[firstChar] = result.length
					} else {
						let index = foundKeys[firstChar] - 1
						result[index].values.push(user)
					}
				}

				const sortedData = _.sortBy(result, 'key') || []
				extensionDetails.data = sortedData
			} else {
				// Check if sortBy and order have values before applying sorting
				if (sortBy) {
					extensionDetails.data = extensionDetails.data.sort((a, b) => {
						// Determine the sorting order based on the 'order' value
						const sortOrder = order.toLowerCase() === 'asc' ? 1 : order.toLowerCase() === 'desc' ? -1 : 1

						// Customize the sorting based on the provided sortBy field
						return sortOrder * a[sortBy].localeCompare(b[sortBy])
					})
				}
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'MENTOR_LIST',
				result: extensionDetails,
			})
		} catch (error) {
			throw error
		}
	}
	/**
	 * @description 							- Filter mentor list based on user's saas policy.
	 * @method
	 * @name filterMentorListBasedOnSaasPolicy
	 * @param {Number} userId 					- User id.
	 * @param {Boolean} isAMentor 				- user mentor or not.
	 * @returns {JSON} 							- List of filtered sessions
	 */
	static async filterMentorListBasedOnSaasPolicy(userId, isAMentor, organization_codes = [], tenantCode, orgCode) {
		try {
			// Always query mentee extension for mentor list filtering policy
			// Even if user is also a mentor/admin, we need their mentee visibility policy
			const userPolicyDetails = await cacheHelper.mentee.get(tenantCode, userId)

			// Throw error if mentor/mentee extension not found
			if (!userPolicyDetails || Object.keys(userPolicyDetails).length === 0) {
				return responses.failureResponse({
					statusCode: httpStatusCode.not_found,
					message: isAMentor ? 'MENTORS_NOT_FOUND' : 'MENTEE_EXTENSION_NOT_FOUND',
					responseCode: 'CLIENT_ERROR',
				})
			}

			let filter = ''
			// searching for specific organization
			let additionalFilter = ``
			if (organization_codes.length !== 0) {
				additionalFilter = `AND "organization_code" in (${organization_codes
					.map((code) => `'${code}'`)
					.join(',')}) `
			}

			if (userPolicyDetails.external_mentor_visibility && userPolicyDetails.organization_id) {
				// Filter user data based on policy
				// generate filter based on condition
				if (userPolicyDetails.external_mentor_visibility === common.CURRENT) {
					/**
					 * if user external_mentor_visibility is current. He can only see his/her organizations mentors
					 * so we will check mentor's organization_code and user organization_code are matching
					 */
					filter = `AND "organization_code" = '${userPolicyDetails.organization_code}'`
				} else if (userPolicyDetails.external_mentor_visibility === common.ASSOCIATED) {
					/**
					 * If user external_mentor_visibility is associated
					 * <<point**>> first we need to check if mentor's visible_to_organizations contain the user organization_code and verify mentor's visibility is not current (if it is ALL and ASSOCIATED it is accessible)
					 */

					filter =
						additionalFilter +
						`AND ( ('${userPolicyDetails.organization_id}' = ANY("visible_to_organizations") AND "mentor_visibility" != 'CURRENT')`

					if (additionalFilter.length === 0)
						filter += ` OR organization_code = '${userPolicyDetails.organization_code}' )`
					else filter += `)`
				} else if (userPolicyDetails.external_mentor_visibility === common.ALL) {
					/**
					 * We need to check if mentor's visible_to_organizations contain the user organization_code and verify mentor's visibility is not current (if it is ALL and ASSOCIATED it is accessible)
					 * OR if mentor visibility is ALL that mentor is also accessible
					 */
					filter =
						additionalFilter +
						`AND (('${userPolicyDetails.organization_id}' = ANY("visible_to_organizations") AND "mentor_visibility" != 'CURRENT' ) OR "mentor_visibility" = 'ALL' OR "organization_code" = '${userPolicyDetails.organization_code}')`
				}
			}

			return filter
		} catch (err) {
			return err
		}
	}

	/**
	 * Sessions list
	 * @method
	 * @name list
	 * @param {Object} req -request data.
	 * @param {String} req.decodedToken.id - User Id.
	 * @param {String} req.pageNo - Page No.
	 * @param {String} req.pageSize - Page size limit.
	 * @param {String} req.searchText - Search text.
	 * @returns {JSON} - Session List.
	 */

	static async createdSessions(
		loggedInUserId,
		page,
		limit,
		search,
		status,
		roles,
		organizationId,
		tenantCode,
		startDate,
		endDate,
		queryParams
	) {
		try {
			if (!utils.isAMentor(roles)) {
				return responses.failureResponse({
					statusCode: httpStatusCode.bad_request,
					message: 'NOT_A_MENTOR',
					responseCode: 'CLIENT_ERROR',
				})
			}

			const currentDate = Math.floor(moment.utc().valueOf() / 1000)

			let arrayOfStatus = []
			if (status && status != '') {
				arrayOfStatus = status.split(',')
			}

			let filters = {
				mentor_id: loggedInUserId,
			}
			if (arrayOfStatus.length > 0) {
				const orConditions = []

				if (arrayOfStatus.includes(common.UPCOMING_STATUS)) {
					// Virtual status — never persisted. An "upcoming" session is a
					// PUBLISHED session whose start_date hasn't arrived yet.
					orConditions.push({
						status: common.PUBLISHED_STATUS,
						start_date: { [Op.gte]: currentDate },
					})
				}

				if (arrayOfStatus.includes(common.LIVE_STATUS)) {
					// LIVE is a real, persisted status (set when a mentor starts the session).
					// But if the mentor hasn't clicked "start" yet, status may still be
					// PUBLISHED even though the session's time window has begun — treat that
					// as LIVE too.
					orConditions.push({ status: common.LIVE_STATUS })
					orConditions.push({
						status: common.PUBLISHED_STATUS,
						start_date: { [Op.lte]: currentDate },
						end_date: { [Op.gte]: currentDate },
					})
				}

				if (arrayOfStatus.includes(common.COMPLETED_STATUS)) {
					orConditions.push({ status: common.COMPLETED_STATUS })
					orConditions.push({
						status: { [Op.in]: [common.PUBLISHED_STATUS, common.LIVE_STATUS] },
						end_date: { [Op.lte]: currentDate },
					})
				}

				// Any other literal statuses (e.g. DRAFT) pass through unchanged,
				// with no extra time constraint.
				const otherStatuses = arrayOfStatus.filter(
					(s) => s !== common.UPCOMING_STATUS && s !== common.LIVE_STATUS && s !== common.COMPLETED_STATUS
				)
				if (otherStatuses.length > 0) {
					orConditions.push({ status: otherStatuses })
				}

				if (orConditions.length > 0) {
					filters[Op.or] = orConditions
				}
			}

			// Apply custom startDate to get upcoming sessions after the startDate. If not passed, it will show all sessions which are completed and upcoming.
			if (startDate) {
				filters['start_date'] = { [Op.gte]: startDate }
			}
			// pass end date to see the sessions which are completed before the end date. If not passed, it will show all sessions which are completed and upcoming.
			if (endDate) {
				filters['end_date'] = { ...(filters['end_date'] || {}), [Op.lte]: endDate }
			}
			// Extract other filters from queryParams excluding status, startDate, endDate
			const excludedParams = ['status', 'startDate', 'endDate']
			const otherFilters = {}

			if (queryParams) {
				for (const [key, value] of Object.entries(queryParams)) {
					// Only add filters that are not in the excluded list and have valid values
					if (!excludedParams.includes(key) && value && value !== '') {
						otherFilters[key] = value
					}
				}
			}

			console.log('Other filters extracted from queryParams:', otherFilters)

			// Validate other filters against valid entityTypes for Session model
			const metaFilters = []
			if (Object.keys(otherFilters).length > 0) {
				// Get all entity types for Session model with data_type to check if they're arrays
				const sessionEntityTypes = await entityTypeQueries.findAllEntityTypes(
					'',
					tenantCode,
					['value', 'model_names', 'data_type'],
					{
						status: common.ACTIVE_STATUS,
						model_names: { [Op.contains]: ['Session'] },
					}
				)

				const entityTypeMap = {}
				sessionEntityTypes.forEach((et) => {
					entityTypeMap[et.value] = et
				})

				for (const [key, value] of Object.entries(otherFilters)) {
					if (entityTypeMap[key]) {
						const entityType = entityTypeMap[key]
						const isArrayType = entityType.data_type && entityType.data_type.includes('ARRAY')

						const filterValue = isArrayType ? [value] : value
						metaFilters.push({
							meta: {
								[Op.contains]: {
									[key]: filterValue,
								},
							},
						})
					} else {
						console.log(`✗ Filter '${key}' is NOT a valid entity type - excluding`)
					}
				}
			}

			if (metaFilters.length > 0) {
				filters[Op.and] = [...(filters[Op.and] || []), ...metaFilters]
			}

			// Get sessions without mentor details (simple database query)
			const sessionDetails = await sessionQueries.findAllSessions(page, limit, search, filters, tenantCode)

			if (
				!sessionDetails ||
				sessionDetails.count == 0 ||
				!sessionDetails.rows ||
				sessionDetails.rows.length == 0
			) {
				return responses.successResponse({
					message: 'SESSION_FETCHED_SUCCESSFULLY',
					statusCode: httpStatusCode.ok,
					result: [],
				})
			}

			// Business logic: Enrich sessions with mentor details
			await this._enrichSessionsWithMentorDetails(sessionDetails.rows, tenantCode)

			//remove meeting_info details except value and platform and add is_assigned flag
			sessionDetails.rows.forEach((item) => {
				if (item.meeting_info) {
					item.meeting_info_details = item.meeting_info
					item.meeting_info = {
						value: item.meeting_info.value,
						platform: item.meeting_info.platform,
					}
				}

				item.is_assigned = item.mentor_id !== item.created_by
				// Normalize org code from enriched organization object for entity type resolution
				item.organization_code = item.organization?.organization_code || null
			})

			// Extract organization codes for entity processing
			const uniqueOrgCodes = [...new Set(sessionDetails.rows.map((obj) => obj.organization_code).filter(Boolean))]

			sessionDetails.rows = await entityTypeService.processEntityTypesToAddValueLabels(
				sessionDetails.rows,
				uniqueOrgCodes,
				common.sessionModelName,
				'organization_code',
				[],
				tenantCode
			)

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'SESSION_FETCHED_SUCCESSFULLY',
				result: { count: sessionDetails.count, data: sessionDetails.rows },
			})
		} catch (error) {
			throw error
		}
	}

	/**
	 * Cancel a session (Support Provider "Cancel Intervention").
	 * Follows the same cancellation steps as admin notifyAndCancelPrivateSessions.
	 * @method
	 * @name cancel
	 * @param {String} sessionId - Session id.
	 * @param {String} userId - Logged in user id.
	 * @param {String} tenantCode - Tenant code.
	 * @param {String} orgCode - Organization code of the logged in user.
	 * @param {Object} bodyData - Request body.
	 * @param {String} bodyData.reason - Reason for cancellation.
	 * @returns {JSON} - Cancel session response.
	 */
	static async cancel(sessionId, userId, tenantCode, orgCode, bodyData) {
		try {
			const { reason } = bodyData
			const sessionDetail = await sessionQueries.findById(sessionId, tenantCode)
			if (!sessionDetail) {
				return responses.failureResponse({
					message: 'SESSION_NOT_FOUND',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			// Only the creator or the mentor of the session can cancel it
			if (sessionDetail.created_by != userId && sessionDetail.mentor_id != userId) {
				return responses.failureResponse({
					message: 'INVALID_PERMISSION',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			if (sessionDetail.status != common.PUBLISHED_STATUS) {
				return responses.failureResponse({
					message: 'CANNOT_CANCEL_SESSION',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			// Mark session as CANCELLED (not soft-deleted) so cancelled sessions stay distinguishable
			// from deleted ones, and record who cancelled it, when and why.
			const updateCount = await sessionQueries.updateRecords(
				{
					status: common.CANCELLED_STATUS,
					meta: {
						...(sessionDetail.meta || {}),
						cancellation: {
							reason,
							cancelled_by: userId,
							cancelled_at: new Date(),
						},
					},
				},
				{ where: { id: sessionDetail.id, tenant_code: tenantCode, status: common.PUBLISHED_STATUS } }
			)
			if (!updateCount || updateCount instanceof Error) {
				return responses.failureResponse({
					message: 'SESSION_CANCELLATION_FAILED',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			// Invalidate session cache
			try {
				await cacheHelper.sessions.delete(tenantCode, sessionDetail.id)
			} catch (cacheErr) {
				console.error(`Cache deletion failed for session ${sessionDetail.id}:`, cacheErr)
			}

			// Remove scheduled reminder jobs so no reminders go out
			const sessionRelatedJobIds = common.notificationJobIdPrefixes.map((element) => element + sessionDetail.id)
			for (const jobId of sessionRelatedJobIds) {
				await schedulerRequest.removeScheduledJob({ jobId })
			}

			// Notify enrolled attendees. A notification failure should not fail the cancellation itself.
			try {
				await this._notifyAttendeesAboutSessionCancellation(sessionDetail, reason, tenantCode, orgCode)
			} catch (notifyErr) {
				console.error(`Failed to notify attendees of cancelled session ${sessionDetail.id}:`, notifyErr)
			}

			console.log(`Cancelled session ${sessionDetail.id} by user ${userId}`)

			return responses.successResponse({
				statusCode: httpStatusCode.accepted,
				message: 'SESSION_CANCELLED_SUCCESSFULLY',
			})
		} catch (error) {
			throw error
		}
	}

	/**
	 * Private method: Email all enrolled attendees that a session has been cancelled.
	 * Uses the same payload shape as the session delete flow in sessions.update.
	 * @param {Object} sessionDetail - Cancelled session.
	 * @param {String} reason - Reason for cancellation.
	 * @param {String} tenantCode - Tenant code.
	 * @param {String} orgCode - Organization code used to resolve the email template.
	 */
	static async _notifyAttendeesAboutSessionCancellation(sessionDetail, reason, tenantCode, orgCode) {
		// Enrolled mentees are stored in session_attendees (written by sessions.enroll via findOrCreateAttendee)
		const sessionAttendees = await sessionAttendeesQueries.findAll({ session_id: sessionDetail.id }, tenantCode)
		if (sessionAttendees instanceof Error) throw sessionAttendees
		if (!sessionAttendees?.length) return

		const templateCode = process.env.SESSION_CANCELLED_EMAIL_TEMPLATE
		const templateData = await cacheHelper.notificationTemplates.get(tenantCode, orgCode, templateCode)
		if (!templateData) {
			console.log(`Template ${templateCode} not found, skipping cancellation emails`)
			return
		}

		const attendeeIds = sessionAttendees.map((attendee) => attendee.mentee_id)
		const attendeesAccounts = await userRequests.getUserDetailedList(attendeeIds, tenantCode, false, true)
		const attendeeDetails = attendeesAccounts?.result || []

		const sessionDuration = Math.round(
			moment.duration(moment.unix(sessionDetail.end_date).diff(moment.unix(sessionDetail.start_date))).asMinutes()
		)
		const startDate = utils.getTimeZone(sessionDetail.start_date, common.dateFormat, sessionDetail.time_zone)
		const startTime = utils.getTimeZone(sessionDetail.start_date, common.timeFormat, sessionDetail.time_zone)

		await Promise.all(
			attendeeDetails
				.filter((attendee) => attendee.email)
				.map((attendee) =>
					kafkaCommunication.pushEmailToKafka({
						type: 'email',
						email: {
							to: attendee.email,
							subject: utils.composeEmailBody(templateData.subject, {
								sessionTitle: sessionDetail.title,
							}),
							body: utils.composeEmailBody(templateData.body, {
								name: attendee.name,
								sessionTitle: sessionDetail.title,
								sessionDuration,
								unitOfTime: common.UNIT_OF_TIME,
								startDate,
								startTime,
								reason,
							}),
						},
					})
				)
		)
		console.log(`Notified ${attendeeDetails.length} attendee(s) about cancellation of session ${sessionDetail.id}`)
	}

	/**
	 * Private method: Enrich sessions with mentor details and process images
	 * Business logic for adding mentor information to session data
	 * @param {Array} sessions - Array of session objects
	 * @param {String} tenantCode - Tenant code for user service calls
	 */
	static async _enrichSessionsWithMentorDetails(sessions, tenantCode) {
		try {
			if (!sessions || sessions.length === 0) {
				return
			}

			// Get unique mentor IDs
			const userIds = _.uniqBy(sessions, 'mentor_id').map((item) => item.mentor_id)

			// Fetch mentor details from User Service
			let mentorDetails = await userRequests.getUserDetailedListUsingCache(userIds, tenantCode)
			mentorDetails = mentorDetails.result

			// Enrich sessions with mentor details
			for (let i = 0; i < sessions.length; i++) {
				let mentorIndex = mentorDetails.findIndex((x) => x.user_id === sessions[i].mentor_id)

				if (mentorIndex !== -1) {
					sessions[i].mentor_name = mentorDetails[mentorIndex].name
					sessions[i].organization = mentorDetails[mentorIndex].organization
				}
			}

			// Process session images
			await Promise.all(
				sessions.map(async (session) => {
					if (session.image && session.image.length > 0) {
						session.image = session.image.map(async (imgPath) => {
							if (imgPath && imgPath != '') {
								return await utils.getDownloadableUrl(imgPath)
							}
						})
						session.image = await Promise.all(session.image)
					}
				})
			)
		} catch (error) {
			console.error('Error enriching sessions with mentor details:', error)
			// Don't throw error to avoid breaking the main flow
		}
	}
}
