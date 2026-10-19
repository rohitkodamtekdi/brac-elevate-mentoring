'use strict'
// Dependenices
const common = require('@constants/common')
const mentorQueries = require('@database/queries/mentorExtension')
const menteeQueries = require('@database/queries/userExtension')
const httpStatusCode = require('@generics/http-status')
const sessionQueries = require('@database/queries/sessions')
const adminService = require('./admin')
const organisationExtensionQueries = require('@database/queries/organisationExtension')
const entityTypeQueries = require('@database/queries/entityType')
const userRequests = require('@requests/user')
const utils = require('@generics/utils')
const _ = require('lodash')
const questionSetQueries = require('../database/queries/question-set')
const { Op } = require('sequelize')
const responses = require('@helpers/responses')
const { getDefaults } = require('@helpers/getDefaultOrgId')
const cacheHelper = require('@generics/cacheHelper')
const mentorsService = require('@services/mentors')

module.exports = class OrgAdminService {
	/**
	 * Updates a provider's mentor extension on their behalf. Only the commitment fields can be set here.
	 * @param {Object} body - { user_id, committed_session?, committed_service?, committed_asset? }
	 */
	static async updateMentorExtension(data, orgCode, tenantCode) {
		try {
			const userId = data.user_id
			delete data.user_id
			data = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))
			if (Object.keys(data).length === 0) {
				return responses.failureResponse({
					message: 'NO_FIELDS_PROVIDED',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}
			// required lazily to avoid a circular dependency between the services
			return await mentorsService.updateMentorExtension(data, userId, orgCode, tenantCode)
		} catch (error) {
			return error
		}
	}

	/**
	 * @description 					- Change user's role based on the current role.
	 * @method
	 * @name 							- roleChange
	 * @param {Object} bodyData 		- The request body containing user data.
	 * @returns {Promise<Object>} 		- A Promise that resolves to a response object.
	 */

	static async roleChange(bodyData, updateData = {}, tenantCode) {
		try {
			bodyData.user_id = bodyData.user_id.toString()
			if (
				utils.validateRoleAccess(bodyData.current_roles, common.MENTOR_ROLE) &&
				utils.validateRoleAccess(bodyData.new_roles, common.MENTEE_ROLE)
			) {
				return await this.changeRoleToMentee(bodyData, updateData, tenantCode)
			} else if (
				utils.validateRoleAccess(bodyData.current_roles, common.MENTEE_ROLE) &&
				utils.validateRoleAccess(bodyData.new_roles, common.MENTOR_ROLE)
			) {
				return await this.changeRoleToMentor(bodyData, updateData, tenantCode)
			}
		} catch (error) {
			throw error
		}
	}

	/**
	 * @description 				- Change user's role to Mentee.
	 * @method
	 * @name 						- changeRoleToMentee
	 * @param {Object} bodyData 	- The request body.
	 * @returns {Object} 			- A Promise that resolves to a response object.
	 */
	static async changeRoleToMentee(bodyData, updateData = {}, tenantCode) {
		try {
			// Check current role based on that swap data
			// If current role is mentor validate data from mentor_extenion table
			let mentorDetails = await mentorQueries.getMentorExtension(bodyData.user_id, [], true, tenantCode)
			// If such mentor return error
			if (!mentorDetails) {
				return responses.failureResponse({
					message: 'MENTOR_EXTENSION_NOT_FOUND',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			if (bodyData.organization_id) {
				bodyData.organization_id = bodyData.organization_id.toString()
				mentorDetails.organization_id = bodyData.organization_id
				const organizationDetails = await userRequests.fetchOrgDetails({
					organizationId: bodyData.organization_id,
					tenantCode,
				})
				if (!(organizationDetails.success && organizationDetails.data && organizationDetails.data.result)) {
					return responses.failureResponse({
						message: 'ORGANIZATION_NOT_FOUND',
						statusCode: httpStatusCode.bad_request,
						responseCode: 'CLIENT_ERROR',
					})
				}

				const orgPolicies = await organisationExtensionQueries.findOrInsertOrganizationExtension(
					bodyData.organization_id,
					bodyData.organization_code,
					organizationDetails.data.result.name,
					tenantCode
				)
				if (!orgPolicies?.organization_id) {
					return responses.failureResponse({
						message: 'ORG_EXTENSION_NOT_FOUND',
						statusCode: httpStatusCode.bad_request,
						responseCode: 'CLIENT_ERROR',
					})
				}
				mentorDetails.organization_id = bodyData.organization_id
				const newPolicy = await this.constructOrgPolicyObject(orgPolicies)
				mentorDetails = _.merge({}, mentorDetails, newPolicy, updateData)
				mentorDetails.visible_to_organizations = Array.from(
					new Set([...(organizationDetails.data.result.related_orgs || []), bodyData.organization_id])
				)
			}
			mentorDetails.is_mentor = false
			if (mentorDetails.email) delete mentorDetails.email
			// Add fetched mentor details to user_extension table
			const menteeCreationData = await menteeQueries.updateMenteeExtension(
				bodyData.user_id,
				mentorDetails,
				{},
				{},
				tenantCode
			)
			if (!menteeCreationData) {
				return responses.failureResponse({
					message: 'MENTEE_EXTENSION_CREATION_FAILED',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
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
					message: 'DEFAULT_TENANT_CODE_NOT_SET',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			// Delete upcoming sessions of user as mentor
			const removedSessionsDetail = await sessionQueries.removeAndReturnMentorSessions(
				bodyData.user_id,
				tenantCode
			)

			if (removedSessionsDetail && removedSessionsDetail.length > 0) {
				for (const userSession of removedSessionsDetail) {
					try {
						await cacheHelper.sessions.delete(tenantCode, userSession.id)
					} catch (cacheError) {
						console.error(`Cache deletion failed for session ${userSession.id}:`, cacheError)
					}
				}
			}

			const isAttendeesNotified = await adminService.unenrollAndNotifySessionAttendees(
				removedSessionsDetail,
				{ [Op.in]: [bodyData.organization_code, defaults.orgCode] },
				tenantCode,
				mentorDetails.organization_code
			)

			// Invalidate mentor cache after role change (mentor -> mentee)
			try {
				await cacheHelper.mentor.delete(tenantCode, bodyData.user_id)
			} catch (cacheError) {
				console.error(`❌ Failed to invalidate mentor cache after role change:`, cacheError)
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'USER_ROLE_UPDATED',
				result: {
					user_id: menteeCreationData.user_id,
					roles: bodyData.new_roles,
				},
			})
		} catch (error) {
			throw error
		}
	}

	/**
	 * @description 				- Change user's role to Mentor.
	 * @method
	 * @name 						- changeRoleToMentor
	 * @param {Object} bodyData 	- The request body containing user data.
	 * @returns {Promise<Object>} 	- A Promise that resolves to a response object.
	 */

	static async changeRoleToMentor(bodyData, updateData = {}, tenantCode) {
		try {
			// Get mentee_extension data
			let menteeDetails = await menteeQueries.getMenteeExtension(bodyData.user_id, '', true, tenantCode)

			// If no mentee present return error
			if (!menteeDetails) {
				return responses.failureResponse({
					statusCode: httpStatusCode.not_found,
					message: 'MENTEE_EXTENSION_NOT_FOUND',
				})
			}

			if (bodyData.organization_id) {
				bodyData.organization_code = bodyData.organization_code.toString()
				let organizationDetails = await userRequests.fetchOrgDetails({
					organizationCode: bodyData.organization_code,
					tenantCode,
				})
				if (!(organizationDetails.success && organizationDetails.data && organizationDetails.data.result)) {
					return responses.failureResponse({
						message: 'ORGANIZATION_NOT_FOUND',
						statusCode: httpStatusCode.bad_request,
						responseCode: 'CLIENT_ERROR',
					})
				}

				const orgPolicies = await organisationExtensionQueries.findOrInsertOrganizationExtension(
					bodyData.organization_id,
					bodyData.organization_code,
					organizationDetails.data.result.name,
					tenantCode
				)
				if (!orgPolicies?.organization_id) {
					return responses.failureResponse({
						message: 'ORG_EXTENSION_NOT_FOUND',
						statusCode: httpStatusCode.bad_request,
						responseCode: 'CLIENT_ERROR',
					})
				}
				menteeDetails.organization_id = bodyData.organization_id
				menteeDetails.organization_code = bodyData.organization_code
				const newPolicy = await this.constructOrgPolicyObject(orgPolicies)
				menteeDetails = _.merge({}, menteeDetails, newPolicy, updateData)
				menteeDetails.visible_to_organizations = Array.from(
					new Set([...(organizationDetails.data.result.related_orgs || []), bodyData.organization_id])
				)
			}

			if (menteeDetails.email) delete menteeDetails.email
			// Add fetched mentee details to mentor_extension table
			const mentorCreationData = await mentorQueries.updateMentorExtension(
				bodyData.user_id,
				menteeDetails,
				'',
				'',
				true,
				tenantCode
			)

			if (!mentorCreationData) {
				return responses.failureResponse({
					message: 'MENTOR_EXTENSION_CREATION_FAILED',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			// Invalidate mentee cache after role change (mentee -> mentor)
			try {
				await cacheHelper.mentee.delete(tenantCode, bodyData.user_id)
			} catch (cacheError) {
				console.error(`❌ Failed to invalidate mentee cache after role change:`, cacheError)
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'USER_ROLE_UPDATED',
				result: {
					user_id: bodyData.user_id,
					roles: bodyData.new_roles,
				},
			})
		} catch (error) {
			throw error
		}
	}

	static async setOrgPolicies(decodedToken, policies, tenantCode) {
		try {
			const orgPolicies = await organisationExtensionQueries.upsert(
				{
					organization_id: decodedToken.organization_id,
					organization_code: decodedToken.organization_code,
					...policies,
					created_by: decodedToken.id,
					updated_by: decodedToken.id,
				},
				tenantCode
			)
			const orgPolicyUpdated =
				new Date(orgPolicies.dataValues.created_at).getTime() !==
				new Date(orgPolicies.dataValues.updated_at).getTime()

			// If org policies updated update mentor and mentee extensions under the org
			if (orgPolicyUpdated) {
				// if org policy is updated update mentor extension and user extension
				let policyData = await this.constructOrgPolicyObject(orgPolicies.dataValues)

				if (
					policyData?.external_mentor_visibility == common.ASSOCIATED ||
					policyData?.mentor_visibility == common.ASSOCIATED ||
					policyData?.external_mentee_visibility == common.ASSOCIATED ||
					policyData?.mentee_visibility == common.ASSOCIATED
				) {
					const organizationDetails = await userRequests.fetchOrgDetails({
						organizationId: decodedToken.organization_id,
						tenantCode,
					})
					policyData.visible_to_organizations = organizationDetails.data.result.related_orgs || []

					if (!policyData.visible_to_organizations.includes(decodedToken.organization_id)) {
						policyData.visible_to_organizations.push(decodedToken.organization_id)
					}
				}

				//Update all users belonging to the org with new policies
				await menteeQueries.updateMenteeExtension(
					'', //userId not required
					policyData, // data to update
					{}, //options
					{ organization_id: decodedToken.organization_id }, //custom filter for where clause
					tenantCode
				)
				// Clear per-user profile caches so stale policy fields are not served after bulk update
				try {
					await cacheHelper.mentee.deleteAll(tenantCode)
					await cacheHelper.mentor.deleteAll(tenantCode)
				} catch (cacheError) {
					console.error('Failed to invalidate mentee/mentor caches after setOrgPolicies:', cacheError)
				}
				// commenting as part of first level SAAS changes. will need this in the code next level
				// await sessionQueries.updateSession(
				// 	{
				// 		status: common.PUBLISHED_STATUS,
				// 		mentor_org_ id: decodedToken.organization _id
				// 	},
				// 	{
				// 		visibility: orgPolicies.dataValues.session_visibility_policy
				// 	}
				// )
			}

			// Proper cache invalidation and update for set policy

			// Delete old cache first if it exists
			await cacheHelper.organizations.delete(
				tenantCode,
				decodedToken.organization_code,
				decodedToken.organization_id
			)

			delete orgPolicies.dataValues.deleted_at
			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'ORG_POLICIES_SET_SUCCESSFULLY',
				result: { ...orgPolicies.dataValues },
			})
		} catch (error) {
			throw new Error(`Error setting organisation policies: ${error.message}`)
		}
	}

	static async getOrgPolicies(decodedToken, tenantCode) {
		try {
			// Try to get from cache first
			let orgPolicies = await cacheHelper.organizations.get(
				tenantCode,
				decodedToken.organization_code,
				decodedToken.organization_id
			)

			if (orgPolicies) {
				delete orgPolicies.deleted_at
				return responses.successResponse({
					statusCode: httpStatusCode.ok,
					message: 'ORG_POLICIES_FETCHED_SUCCESSFULLY',
					result: { ...orgPolicies },
				})
			}

			// If not in cache, fetch from database
			orgPolicies = await organisationExtensionQueries.getById(decodedToken.organization_code, tenantCode)

			delete orgPolicies.deleted_at
			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'ORG_POLICIES_FETCHED_SUCCESSFULLY',
				result: { ...orgPolicies },
			})
		} catch (error) {
			throw new Error(`Error reading organisation policies: ${error.message}`)
		}
	}

	/**
	 * @description 					- Inherit new entity type from an existing default org's entityType.
	 * @method
	 * @name 							- inheritEntityType
	 * @param {String} entityValue 		- Entity type value
	 * @param {String} entityLabel 		- Entity type label
	 * @param {String} userOrgCode 		- User org code
	 * @param {Object} decodedToken 	- User token details
	 * @returns {Promise<Object>} 		- A Promise that resolves to a response object.
	 */

	static async inheritEntityType(entityValue, entityLabel, userOrgCode, decodedToken, tenantCode) {
		try {
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

			if (defaults.orgCode === userOrgCode) {
				return responses.failureResponse({
					message: 'USER_IS_FROM_DEFAULT_ORG',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			// Fetch entity type data using organization_code and entityValue
			const filter = {
				value: entityValue,
				organization_code: defaults.orgCode,
				allow_filtering: true,
			}

			let entityTypeDetails = await entityTypeQueries.findOneEntityType(filter, tenantCode)

			// If no matching data found return failure response
			if (!entityTypeDetails) {
				return responses.failureResponse({
					message: 'ENTITY_TYPE_NOT_FOUND',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			// Build data for inheriting entityType
			entityTypeDetails.parent_id = entityTypeDetails.id
			entityTypeDetails.label = entityLabel
			entityTypeDetails.organization_id = decodedToken.organization_id
			entityTypeDetails.organization_code = decodedToken.organization_code
			entityTypeDetails.created_by = decodedToken.id
			entityTypeDetails.updated_by = decodedToken.id
			delete entityTypeDetails.id

			// Create new inherited entity type
			let inheritedEntityType = await entityTypeQueries.createEntityType(
				entityTypeDetails,
				decodedToken.tenant_code
			)
			return responses.successResponse({
				statusCode: httpStatusCode.created,
				message: 'ENTITY_TYPE_CREATED_SUCCESSFULLY',
				result: inheritedEntityType,
			})
		} catch (error) {
			throw error
		}
	}

	/**
	 * Update User Organization.
	 * @method
	 * @name updateOrganization
	 * @param {Object} bodyData
	 * @returns {JSON} - User data.
	 */
	static async updateOrganization(bodyData, tenantCode) {
		try {
			bodyData.user_id = bodyData.user_id.toString()
			bodyData.organization_id = bodyData.organization_id.toString()
			const orgId = bodyData.organization_id
			// Get organization details
			let organizationDetails = await userRequests.fetchOrgDetails({ organizationId: orgId, tenantCode })
			if (!(organizationDetails.success && organizationDetails.data && organizationDetails.data.result)) {
				return responses.failureResponse({
					message: 'ORGANIZATION_NOT_FOUND',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
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
					message: 'DEFAULT_TENANT_CODE_NOT_SET',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})

			// Get organization policies
			const orgPolicies = await organisationExtensionQueries.findOrInsertOrganizationExtension(
				orgId,
				bodyData.organization_code,
				organizationDetails.data.result.name,
				tenantCode
			)
			if (!orgPolicies?.organization_id) {
				return responses.failureResponse({
					message: 'ORG_EXTENSION_NOT_FOUND',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			//Update the policy
			const updateData = {
				organization_id: orgId,
				external_session_visibility: orgPolicies.external_session_visibility_policy,
				external_mentor_visibility: orgPolicies.external_mentor_visibility_policy,
				mentor_visibility: orgPolicies.mentor_visibility_policy,
				mentee_visibility: orgPolicies.mentee_visibility_policy,
				external_mentee_visibility: orgPolicies.external_mentee_visibility_policy,
				visible_to_organizations: organizationDetails.data.result.related_orgs || [],
			}
			if (!updateData.visible_to_organizations.includes(orgId)) {
				updateData.visible_to_organizations.push(orgId)
			}

			if (utils.validateRoleAccess(bodyData.roles, common.MENTOR_ROLE)) {
				await mentorQueries.updateMentorExtension(bodyData.user_id, updateData, {}, {}, false, tenantCode)

				// Cache invalidation: Clear mentor cache after organization update
				try {
					await cacheHelper.mentor.delete(tenantCode, bodyData.user_id)
				} catch (cacheError) {
					console.error(`Cache deletion failed for mentor ${bodyData.user_id} after org update:`, cacheError)
				}
			} else {
				await menteeQueries.updateMenteeExtension(bodyData.user_id, updateData, {}, {}, tenantCode)

				// Cache invalidation: Clear mentee cache after organization update
				try {
					await cacheHelper.mentee.delete(tenantCode, bodyData.user_id)
				} catch (cacheError) {
					console.error(`Cache deletion failed for mentee ${bodyData.user_id} after org update:`, cacheError)
				}
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'UPDATE_ORG_SUCCESSFULLY',
			})
		} catch (error) {
			throw error
		}
	}

	/**
	 * Deactivate upcoming session.
	 * @method
	 * @name deactivateUpcomingSession
	 * @param {Object} bodyData
	 * @returns {JSON} - User data.
	 */
	static async deactivateUpcomingSession(userIds, tenantCode, orgCode) {
		try {
			userIds = userIds.map(String)
			let deactivatedIdsList = []
			let failedUserIds = []
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
			for (let key in userIds) {
				const userId = userIds[key]
				// Try cache first using logged-in user's organization context
				let mentorDetails = await cacheHelper.mentor.get(tenantCode, userId)
				if (mentorDetails?.user_id) {
					// Deactivate upcoming sessions of user as mentor
					const removedSessionsDetail = await sessionQueries.deactivateAndReturnMentorSessions(
						userId,
						tenantCode
					)
					await adminService.unenrollAndNotifySessionAttendees(
						removedSessionsDetail,
						{ [Op.in]: [orgCode, defaults.orgCode] },
						tenantCode,
						orgCode
					)
					deactivatedIdsList.push(userId)
				}

				//unenroll from upcoming session
				// Try cache first using logged-in user's organization context
				let menteeDetails = await cacheHelper.mentee.get(tenantCode, userId)
				if (menteeDetails?.user_id) {
					await adminService.unenrollFromUpcomingSessions(userId, tenantCode)
					deactivatedIdsList.push(userId)
				}

				if (!mentorDetails?.user_id && !menteeDetails?.user_id) {
					failedUserIds.push(userId)
				}
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: failedUserIds.length > 0 ? 'SESSION_DEACTIVATION_FAILED' : 'SESSION_DEACTIVATED_SUCCESSFULLY',
				result: {
					deactivatedIdsList: deactivatedIdsList,
					failedUserIds: failedUserIds,
				},
			})
		} catch (error) {
			throw error
		}
	}
	/**
	 * @description 							- constuct organisation policy object for mentor_extension/user_extension.
	 * @method
	 * @name 									- constructOrgPolicyObject
	 * @param {Object} organisationPolicy 		- organisation policy data
	 * @param {Boolean} addOrgId 				- Boolean that specifies if org_ id needs to be added or not
	 * @returns {Object} 						- A object that reurn a response object.
	 */
	static async constructOrgPolicyObject(organisationPolicy, addOrgId = false) {
		const {
			mentor_visibility_policy,
			external_session_visibility_policy,
			external_mentor_visibility_policy,
			organization_id,
			external_mentee_visibility_policy,
			mentee_visibility_policy,
		} = organisationPolicy
		// create policy object
		let policyData = {
			mentee_visibility: mentee_visibility_policy,
			mentor_visibility: mentor_visibility_policy,
			external_session_visibility: external_session_visibility_policy,
			external_mentor_visibility: external_mentor_visibility_policy,
			external_mentee_visibility: external_mentee_visibility_policy,
		}
		// add org_ id value if requested
		if (addOrgId) {
			policyData.organization_id = organization_id
		}
		return policyData
	}

	/**
	 * @description 							- update related organization of mentees and mentors if there is an update in the organization
	 * @method									- POST
	 * @name 									- updateRelatedOrgs
	 * @param {Array} relatedOrgs 		 		- Array of related organization passed
	 * @param {Number} orgId 					- Specific orgId which was updated
	 * @param {Object} organizationDetails 		- Object of organization details of the related org from user service.
	 * @returns {Object} 						- A object that reurn a response object.
	 */
	static async updateRelatedOrgs(deltaOrganizationIds, orgId, action, tenantCode) {
		try {
			orgId = orgId.toString()
			deltaOrganizationIds = deltaOrganizationIds.map(String)
			if (action === common.PUSH) {
				await menteeQueries.addVisibleToOrg(orgId, deltaOrganizationIds, tenantCode)
			} else if (action === common.POP) {
				await menteeQueries.removeVisibleToOrg(orgId, deltaOrganizationIds, tenantCode)
			}

			// Clear per-user profile caches — visible_to_organizations field is cached in mentee/mentor profiles
			try {
				await cacheHelper.mentee.deleteAll(tenantCode)
				await cacheHelper.mentor.deleteAll(tenantCode)
			} catch (cacheError) {
				console.error('Failed to invalidate mentee/mentor caches after updateRelatedOrgs:', cacheError)
			}

			// Invalidate organization cache for the affected organization
			try {
				// Get organization details to extract orgCode for cache invalidation
				const organizationDetails = await userRequests.fetchOrgDetails({ organizationId: orgId, tenantCode })
				const orgCode = organizationDetails?.data?.result?.code
				if (orgCode) {
					await cacheHelper.organizations.delete(tenantCode, orgCode, orgId)
				}
			} catch (cacheError) {
				console.error(`Failed to invalidate organization cache after updateRelatedOrgs:`, cacheError)
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'RELATED_ORG_UPDATED',
			})
		} catch (error) {
			throw error
		}
	}

	static async setDefaultQuestionSets(bodyData, decodedToken, tenantCode) {
		try {
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

			const questionSets = await questionSetQueries.findQuestionSets(
				{
					code: { [Op.in]: [bodyData.mentee_feedback_question_set, bodyData.mentor_feedback_question_set] },
					tenant_code: tenantCode,
				},
				['id', 'code']
			)
			if (
				questionSets.length === 0 ||
				(questionSets.length === 1 &&
					bodyData.mentee_feedback_question_set !== bodyData.mentor_feedback_question_set)
			) {
				return responses.failureResponse({
					message: 'QUESTIONS_SET_NOT_FOUND',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}
			const extensionData = {
				organization_id: decodedToken.id,
				mentee_feedback_question_set: bodyData.mentee_feedback_question_set,
				mentor_feedback_question_set: bodyData.mentor_feedback_question_set,
				updated_by: decodedToken.id,
			}
			const orgExtension = await organisationExtensionQueries.upsert(extensionData, tenantCode)
			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'ORG_DEFAULT_QUESTION_SETS_SET_SUCCESSFULLY',
				result: {
					organization_id: orgExtension.organization_id,
					mentee_feedback_question_set: orgExtension.mentee_feedback_question_set,
					mentor_feedback_question_set: orgExtension.mentor_feedback_question_set,
					updated_by: orgExtension.updated_by,
				},
			})
		} catch (error) {
			return error
		}
	}

	static async uploadSampleCSV(filepath, orgCode, tenantCode) {
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

		const newData = { uploads: { session_csv_path: filepath } }
		if (orgCode != defaults.orgCode) {
			let result = await organisationExtensionQueries.update(newData, orgCode, tenantCode)
			if (!result) {
				return responses.failureResponse({
					message: 'CSV_UPDATE_FAILED',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			// Invalidate organization cache after CSV upload
			try {
				const organizationDetails = await userRequests.fetchOrgDetails({
					organizationCode: orgCode,
					tenantCode,
				})
				if (organizationDetails.success && organizationDetails.data && organizationDetails.data.result) {
					const orgId = organizationDetails.data.result.id
					await cacheHelper.organizations.delete(tenantCode, orgCode, orgId)
				}
			} catch (cacheError) {
				console.error(`Failed to invalidate organization cache after CSV upload:`, cacheError)
			}

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'CSV_UPLOADED_SUCCESSFULLY',
			})
		}
		return responses.failureResponse({
			message: 'CSV_UPDATE_FAILED',
			statusCode: httpStatusCode.bad_request,
			responseCode: 'CLIENT_ERROR',
		})
	}

	/**
	 * Update the theme for a specific organization.
	 * @method
	 * @name updateTheme
	 * @param {Object} data - The theme data to be updated.
	 * @param {String} orgId - The organization ID for which the theme needs to be updated.
	 * @returns {Object} - The result of the theme update, either success or error details.
	 */
	static async updateTheme(data, orgCode, tenantCode) {
		let organizationDetails = await userRequests.fetchOrgDetails({ organizationCode: orgCode, tenantCode })
		if (!(organizationDetails.success && organizationDetails.data && organizationDetails.data.result)) {
			return responses.failureResponse({
				message: 'ORGANIZATION_NOT_FOUND',
				statusCode: httpStatusCode.bad_request,
				responseCode: 'CLIENT_ERROR',
			})
		}

		const newData = { theme: data }
		let result = await organisationExtensionQueries.update(newData, orgCode, tenantCode)
		if (!result) {
			return responses.failureResponse({
				message: 'FAILED_TO_UPDATED_ORG_THEME',
				statusCode: httpStatusCode.bad_request,
				responseCode: 'CLIENT_ERROR',
			})
		}

		// Invalidate organization cache after theme update
		try {
			const orgId = organizationDetails.data.result.id
			await cacheHelper.organizations.delete(tenantCode, orgCode, orgId)
		} catch (cacheError) {
			console.error(`Failed to invalidate organization cache after theme update:`, cacheError)
		}

		return responses.successResponse({
			statusCode: httpStatusCode.ok,
			message: 'ORG_THEME_UPDATED_SUCCESSFULLY',
		})
	}

	static async themeDetails(orgCode, tenantCode) {
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

		// Try to get organization details and theme from cache first
		let organizationDetails = null
		try {
			const organizationInfo = await userRequests.fetchOrgDetails({ organizationCode: orgCode, tenantCode })
			if (organizationInfo.success && organizationInfo.data && organizationInfo.data.result) {
				const orgId = organizationInfo.data.result.id
				organizationDetails = await cacheHelper.organizations.get(tenantCode, orgCode, orgId)
				if (organizationDetails) {
					return responses.successResponse({
						statusCode: httpStatusCode.ok,
						message: 'ORG_THEME_FETCHED_SUCCESSFULLY',
						result: organizationDetails.theme,
					})
				}
			}
		} catch (cacheError) {
			console.warn('Failed to get organization theme from cache:', cacheError)
		}

		// If not in cache, fetch from database
		organizationDetails = await organisationExtensionQueries.getById(
			{ [Op.in]: [defaults.orgCode, orgCode] },
			tenantCode
		)

		if (!organizationDetails) {
			return responses.failureResponse({
				message: 'ORGANIZATION_NOT_FOUND',
				statusCode: httpStatusCode.bad_request,
				responseCode: 'CLIENT_ERROR',
			})
		}

		// Cache the organization details for future use
		try {
			const organizationInfo = await userRequests.fetchOrgDetails({ organizationCode: orgCode, tenantCode })
			if (organizationInfo.success && organizationInfo.data && organizationInfo.data.result) {
				const orgId = organizationInfo.data.result.id
				await cacheHelper.organizations.set(tenantCode, orgCode, orgId, organizationDetails)
			}
		} catch (cacheError) {
			console.error(`❌ Failed to cache organization after theme fetch:`, cacheError)
		}

		return responses.successResponse({
			statusCode: httpStatusCode.ok,
			message: 'ORG_THEME_FETCHED_SUCCESSFULLY',
			result: organizationDetails.theme,
		})
	}
}
