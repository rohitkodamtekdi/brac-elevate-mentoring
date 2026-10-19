// Dependencies
const httpStatusCode = require('@generics/http-status')
const common = require('@constants/common')
const userRequests = require('@requests/user')
const menteeQueries = require('@database/queries/userExtension')
const mentorQueries = require('@database/queries/mentorExtension')
const responses = require('@helpers/responses')

const organisationExtensionQueries = require('@database/queries/organisationExtension')
const mentorsService = require('@services/mentors')
const menteesService = require('@services/mentees')
const orgAdminService = require('@services/org-admin')

const userServiceHelper = require('@helpers/users')
const cacheHelper = require('@generics/cacheHelper')
const { Op } = require('sequelize')
module.exports = class UserHelper {
	/**
	 * Get user list.
	 * @method
	 * @name create
	 * @param {String} userType 				- mentee/mentor.
	 * @param {Number} pageSize 				- Page size.
	 * @param {Number} pageNo 					- Page number.
	 * @param {String} searchText 				- Search text.
	 * @param {Number} searchText 				- userId.
	 * @returns {JSON} 							- User list.
	 */

	static async list(
		userType,
		pageNo,
		pageSize,
		searchText,
		userId,
		organizationId,
		tenantCode,
		query = { alphaSort: 'true' }
	) {
		try {
			if (!query?.alphaSort || query?.alphaSort === 'false') {
				const filter = {
					query: '',
					replacements: {},
				}

				// Add conditions to the filter based on userType or searchText
				if (userType) {
					filter.query += `is_mentor = :is_mentor `
					filter.replacements.is_mentor = userType.toLowerCase() === common.MENTOR_ROLE ? true : false
				}

				if (query?.notNullFields) {
					const notNullFields = query.notNullFields.split(',').map((field) => field.trim())
					if (notNullFields.length) {
						filter.query +=
							(filter.query ? ' AND ' : '') +
							notNullFields.map((field) => `${field} IS NOT NULL`).join(' AND ')
					}
				}

				const userDetails = await menteeQueries.getAllUsers(
					[],
					pageNo,
					pageSize,
					filter,
					'',
					query?.notNullFields,
					false,
					searchText ? searchText : '',
					'',
					tenantCode
				)
				return responses.successResponse({
					statusCode: httpStatusCode.ok,
					message: 'USER_DETAILS_FETCHED_SUCCESSFULLY',
					result: userDetails,
				})
			}

			const userDetails = await userRequests.list(userType, pageNo, pageSize, searchText, tenantCode)
			const ids = userDetails.result.data.map((item) => item.values[0].user_id)

			let extensionDetails
			if (userType == common.MENTEE_ROLE) {
				extensionDetails = await menteeQueries.getUsersByUserIds(
					ids,
					{
						attributes: ['user_id', 'rating'],
					},
					tenantCode
				)
			} else if (userType == common.MENTOR_ROLE) {
				extensionDetails = await mentorQueries.getMentorsByUserIds(
					ids,
					{
						attributes: ['user_id', 'rating', 'mentor_visibility', 'organization_id'],
					},
					tenantCode
				)
				extensionDetails = extensionDetails.filter((item) => item.mentor_visibility && item.organization_id)
			}
			const extensionDataMap = new Map(extensionDetails.map((newItem) => [newItem.user_id, newItem]))

			userDetails.result.data = userDetails.result.data.filter((existingItem) => {
				const user_id = existingItem.values[0].id
				if (extensionDataMap.has(user_id)) {
					const newItem = extensionDataMap.get(user_id)
					existingItem.values[0] = { ...existingItem.values[0], ...newItem }
					delete existingItem.values[0].user_id
					delete existingItem.values[0].mentor_visibility
					delete existingItem.values[0].organization_id
					return true
				}

				return false
			})

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: userDetails.message,
				result: userDetails.result,
			})
		} catch (error) {
			throw error
		}
	}

	static async create(decodedToken, userId, organizationId, tenantCode) {
		try {
			const isNewUser = await this.#checkUserExistence(decodedToken.id, decodedToken.tenant_code)
			if (isNewUser) {
				const result = await this.#createOrUpdateUserAndOrg(decodedToken.id, isNewUser, decodedToken)
				return result
			} else {
				// Skip cache during user creation - get fresh data from database
				let menteeExtension = await menteeQueries.findOne(
					{ user_id: decodedToken.id },
					decodedToken.tenant_code
				)
				if (!menteeExtension) {
					return responses.failureResponse({
						statusCode: httpStatusCode.not_found,
						message: 'USER_NOT_FOUND',
					})
				}

				return responses.successResponse({
					statusCode: httpStatusCode.ok,
					message: 'USER_DETAILS_FETCHED_SUCCESSFULLY',
					result: menteeExtension,
				})
			}
		} catch (error) {
			throw error
		}
	}

	static async update(updateData, decodedToken, userId, organizationId, tenantCode) {
		try {
			const userId = updateData.userId

			const userTenantCode = updateData.tenantCode ? updateData.tenantCode : decodedToken.tenant_code
			const isNewUser = await this.#checkUserExistence(userId, userTenantCode)
			const result = await this.#createOrUpdateUserAndOrg(userId, isNewUser, undefined, tenantCode)
			return result
		} catch (error) {
			throw error
		}
	}

	static async add(bodyData, userId, organizationId, tenantCode) {
		bodyData.id = bodyData.id.toString()

		let result = {}
		const isNewUser = await this.#checkUserExistence(bodyData.id, tenantCode)

		if (isNewUser) {
			result = await this.#createUserWithBody(bodyData, tenantCode)
		} else {
			bodyData.new_roles = bodyData.newValues?.organizations?.[0]?.roles ?? []
			const targetHasMentorRole = bodyData.new_roles.some((role) => role.title === common.MENTOR_ROLE)
			result = await this.#createOrUpdateUserAndOrg(bodyData.id, isNewUser, targetHasMentorRole)
		}

		return result
	}

	static async #createUserWithBody(userBody, tenantCode) {
		let orgId = userBody.organization_id || userBody.organizations?.[0]?.id
		let orgCode = userBody.organization_code || userBody.organizations?.[0]?.code

		// Check if orgId exists before calling toString()
		if (!orgId) {
			return responses.failureResponse({
				message: 'ORGANIZATION_ID_REQUIRED',
				statusCode: httpStatusCode.bad_request,
				responseCode: 'CLIENT_ERROR',
			})
		}

		const orgExtension = await this.#createOrUpdateOrg({ id: orgId.toString(), code: orgCode }, tenantCode)

		if (!orgExtension) {
			return responses.failureResponse({
				message: 'ORG_EXTENSION_NOT_FOUND',
				statusCode: httpStatusCode.not_found,
				responseCode: 'UNAUTHORIZED',
			})
		}
		const userExtensionData = this.#getExtensionData(userBody, orgExtension)

		const createResult = await this.#createUser({ ...userExtensionData, roles: userBody.roles }, tenantCode)

		if (createResult.statusCode != httpStatusCode.ok) return createResult
		else
			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'PROFILE_CREATED_SUCCESSFULLY',
				result: createResult.result,
			})
	}
	static async #createOrUpdateUserAndOrg(userId, isNewUser, targetHasMentorRole = undefined, tenantCode = '') {
		const userDetails = await userRequests.fetchUserDetails({ userId, tenantCode })
		if (!userDetails?.data?.result) {
			return responses.failureResponse({
				message: 'SOMETHING_WENT_WRONG',
				statusCode: httpStatusCode.not_found,
				responseCode: 'UNAUTHORIZED',
			})
		}

		const validationError = await this.#validateUserDetails(userDetails)

		if (validationError) {
			return responses.failureResponse({
				message: validationError,
				statusCode: httpStatusCode.not_found,
				responseCode: 'UNAUTHORIZED',
			})
		}

		const orgExtension = await this.#createOrUpdateOrg(
			{ id: userDetails.data.result.organization.id, code: userDetails.data.result.organization.code },
			userDetails.data.result.tenant_code
		)

		if (!orgExtension) {
			return responses.failureResponse({
				message: 'ORG_EXTENSION_NOT_FOUND',
				statusCode: httpStatusCode.not_found,
				responseCode: 'UNAUTHORIZED',
			})
		}
		const userExtensionData = this.#getExtensionData(userDetails.data.result, orgExtension)
		const createOrUpdateResult = isNewUser
			? await this.#createUser(userExtensionData, userDetails.data.result.tenant_code)
			: await this.#updateUser(userExtensionData, userDetails.data.result.tenant_code, targetHasMentorRole)
		if (createOrUpdateResult.statusCode != httpStatusCode.ok) return createOrUpdateResult
		else
			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'PROFILE_CREATED_SUCCESSFULLY',
				result: createOrUpdateResult.result,
			})
	}

	static #getExtensionData(userDetails, orgExtension) {
		const data = {
			id: userDetails.id.toString(),
			name: userDetails?.name,
			organization: {
				id: orgExtension.organization_id.toString(),
				code: orgExtension.organization_code.toString(),
			},
		}
		let roles = userDetails?.roles || userDetails?.user_roles
		if (!roles && userDetails.organization?.roles) {
			roles = userDetails.organization.roles
		} else if (!roles && Array.isArray(userDetails.organizations) && userDetails.organizations[0]?.roles) {
			roles = userDetails.organizations[0].roles
		}

		// List of optional fields to check
		const optionalFields = {
			roles: roles,
			email: userDetails?.email,
			phone: userDetails?.phone,
			skipValidation: true,
			competency: userDetails?.competency,
			designation: userDetails?.designation,
			language: userDetails?.language,
			image: userDetails?.image_cloud_path || userDetails?.image || '',
		}

		// Add only defined values to the data object
		Object.entries(optionalFields).forEach(([key, value]) => {
			if (value !== undefined && value !== null) {
				data[key] = value
			}
		})

		return data
	}

	static async #createOrUpdateOrg(orgData, tenantCode) {
		// Try to get from cache first
		let orgExtension = await cacheHelper.organizations.get(tenantCode, orgData.code, orgData.id)

		if (orgExtension) {
			return orgExtension
		}

		// Use organization_id as organization_code for lookup since they're the same in user service data
		orgExtension = await organisationExtensionQueries.getById(orgData.code, tenantCode)
		if (orgExtension) {
			// Cache the found organization
			try {
				await cacheHelper.organizations.set(tenantCode, orgData.code, orgData.id, orgExtension)
			} catch (cacheError) {
				console.error(`❌ Failed to cache organization ${orgData.id}:`, cacheError)
			}
			return orgExtension
		}

		const orgExtensionData = {
			...common.getDefaultOrgPolicies(),
			organization_id: orgData.id,
			organization_code: orgData.code,
			created_by: 1,
			updated_by: 1,
			tenant_code: tenantCode,
		}
		orgExtension = await organisationExtensionQueries.upsert(orgExtensionData, tenantCode)
		const orgResult = orgExtension.toJSON()

		// Clear organization cache after write operation to ensure consistency
		try {
			await cacheHelper.organizations.delete(tenantCode, orgData.code, orgData.id)
		} catch (cacheError) {
			console.error(`❌ Failed to clear organization cache ${orgData.id}:`, cacheError)
		}

		return orgResult
	}

	static async #createUser(userExtensionData, tenantCode) {
		const roles = Array.isArray(userExtensionData.roles) ? userExtensionData.roles : []
		const isAMentor = roles.some((role) => (typeof role === 'object' ? role.title : role) == common.MENTOR_ROLE)
		const orgId = userExtensionData.organization.id
		const orgCode = userExtensionData.organization.code
		const user = isAMentor
			? await mentorsService.createMentorExtension(
					userExtensionData,
					userExtensionData.id,
					orgCode,
					tenantCode,
					orgId
			  )
			: await menteesService.createMenteeExtension(
					userExtensionData,
					userExtensionData.id,
					orgCode,
					tenantCode,
					orgId
			  )

		return user
	}

	static #checkOrgChange = (existingOrgId, newOrgId) => existingOrgId !== newOrgId

	static async #updateUser(userExtensionData, tenant_code, targetHasMentorRole) {
		const isAMentee = userExtensionData.roles.some((role) => role.title === common.MENTEE_ROLE)
		const isAMentor = userExtensionData.roles.some((role) => role.title === common.MENTOR_ROLE)
		const roleChangePayload = {
			user_id: userExtensionData.id,
			organization_id: userExtensionData.organization.id,
			organization_code: userExtensionData.organization.code,
		}

		let isRoleChanged = false

		// Skip cache during user updates - role changes require fresh data from database
		let menteeExtension = await menteeQueries.findOne({ user_id: userExtensionData.id }, tenant_code)

		if (!menteeExtension) throw new Error('User Not Found')

		if (isAMentor && !menteeExtension.is_mentor) {
			roleChangePayload.current_roles = [common.MENTEE_ROLE]
			roleChangePayload.new_roles = [common.MENTOR_ROLE]
			isRoleChanged = true
		}
		if (!isAMentor && menteeExtension.is_mentor) {
			roleChangePayload.current_roles = [common.MENTOR_ROLE]
			roleChangePayload.new_roles = [common.MENTEE_ROLE]
			isRoleChanged = true
		}

		if (targetHasMentorRole) {
			roleChangePayload.current_roles = [common.MENTEE_ROLE]
			roleChangePayload.new_roles = [common.MENTOR_ROLE]
			isRoleChanged = true
		}

		if (isRoleChanged) {
			//If role is changed, the role change, org policy changes for that user
			//and additional data update of the user is done by orgAdmin's roleChange workflow
			const roleChangeResult = await orgAdminService.roleChange(roleChangePayload, userExtensionData, tenant_code)

			// Invalidate cache after role change - separate try-catch for each cache
			try {
				await cacheHelper.mentee.delete(tenant_code, userExtensionData.id)
			} catch (cacheError) {
				console.error(`❌ Failed to invalidate mentee cache after role change:`, cacheError)
			}

			try {
				await cacheHelper.mentor.delete(tenant_code, userExtensionData.id)
			} catch (cacheError) {
				console.error(`❌ Failed to invalidate mentor cache after role change:`, cacheError)
			}

			return roleChangeResult
		} else {
			if (userExtensionData.email) delete userExtensionData.email
			//If role is not changed, org policy changes along with other user data updation is done
			//using the updateMentee or updateMentor workflows
			const user = isAMentee
				? await menteesService.updateMenteeExtension(
						userExtensionData,
						userExtensionData.id,
						userExtensionData.organization.code,
						userExtensionData.tenant_code
				  )
				: await mentorsService.updateMentorExtension(
						userExtensionData,
						userExtensionData.id,
						userExtensionData.organization.code,
						userExtensionData.tenant_code
				  )

			// Invalidate cache after user update
			try {
				if (isAMentee) {
					await cacheHelper.mentee.delete(tenant_code, userExtensionData.id)
				} else {
					await cacheHelper.mentor.delete(tenant_code, userExtensionData.id)
				}
			} catch (cacheError) {
				console.error(`❌ Failed to invalidate user cache after update:`, cacheError)
			}

			return user
		}
	}

	/**
	 * Checks the existence of a user based on their mentee extension.
	 * Uses caching to improve performance for frequent user existence checks.
	 *
	 * @param {string} userId - The ID of the user to check.
	 * @param {string} tenantCode - The tenant code for multi-tenant isolation.
	 * @returns {Promise<boolean>} - Returns `true` if the user does not exist, `false` otherwise.
	 * @throws {Error} - Throws an error if the query fails.
	 */
	static async #checkUserExistence(userId, tenantCode) {
		try {
			// Check mentee extension for user existence
			const menteeExtension = await menteeQueries.getMenteeExtension(
				userId,
				['organization_id'],
				false,
				tenantCode
			)

			const userExists = menteeExtension !== null
			return !userExists // Return true if user does not exist
		} catch (error) {
			throw error
		}
	}

	/**
	 * Validates that the required user details are present and not null/undefined.
	 *
	 * This function checks if the userDetails object contains the necessary fields
	 * for processing a user. It specifically looks for:
	 * - id
	 * - user_roles
	 * - email
	 * - name
	 * - organization
	 * - organization_id
	 *
	 * If any of these fields are missing or null, the function returns an error message.
	 *
	 * @param {Object} userDetails - The user details object containing user data.
	 * @returns {string|null} - Returns an error message if validation fails, otherwise null.
	 */

	static async #validateUserDetails(userDetails) {
		if (!userDetails.data.result) {
			return 'FAILED_TO_GET_REQUIRED_USER_DETAILS'
		} else {
			const requiredFields = [
				'id',
				'user_roles',
				'email',
				'name',
				'organization_code',
				'organization_id',
				'tenant_code',
			]
			for (const field of requiredFields) {
				if (!userDetails.data.result[field] || userDetails.data.result[field] == null) {
					return 'FAILED_TO_GET_REQUIRED_USER_DETAILS'
				}
			}
		}
		return null
	}

	/**
	 * Get user requestCount.
	 * @method
	 * @name requestCount
	 * @param {String} userId 					- userId	.
	 * @returns {JSON} 							- request count.
	 */

	static async requestCount(userId, tenantCode) {
		try {
			const response = await userServiceHelper.findRequestCounts(userId, tenantCode)

			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'REQUESTS_COUNT_FETCHED',
				result: response,
			})
		} catch (error) {
			throw error
		}
	}
}
