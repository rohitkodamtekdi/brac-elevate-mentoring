/**
 * name : feedback.js
 * author : Rakesh Kumar
 * created-date : 02-Dec-2021
 * Description : Users Controller.
 */

// Dependencies
const { isAMentor } = require('@generics/utils')
const feedbackService = require('@services/feedback')
const userService = require('@services/users')
const adminService = require('@services/admin')
const httpStatusCode = require('@generics/http-status')
const responses = require('@helpers/responses')

module.exports = class Users {
	/**
	 * Pending feedback.
	 * @method
	 * @name pendingFeedbacks
	 * @param {Object} req -request data.
	 * @param {String} req.decodedToken.id - User Id.
	 * @param {String} req.decodedToken.isAMentor - User Mentor key true/false.
	 * @returns {JSON} - Pending feedback information.
	 */

	async pendingFeedbacks(req) {
		try {
			const pendingFeedBacks = await feedbackService.pending(
				req.decodedToken.id,
				isAMentor(req.decodedToken.roles),
				req.decodedToken.organization_code,
				req.decodedToken.tenant_code
			)
			return pendingFeedBacks
		} catch (error) {
			return error
		}
	}

	/**
	 * list user based on type
	 * @method
	 * @name list
	 * @param {Object} req 						- request data.
	 * @param {Boolean} req.query.type 			- User Type mentor/mentee
	 * @param {Number} req.pageNo 				- page no.
	 * @param {Number} req.pageSize 			- page size limit.
	 * @param {String} req.searchText 			- search text.
	 * @returns {JSON} 							- List of user.
	 */

	async list(req) {
		try {
			const listUser = await userService.list(
				req.query.type,
				req.pageNo,
				req.pageSize,
				req.searchText,
				req.decodedToken.id,
				req.decodedToken.organization_code,
				req.decodedToken.tenant_code,
				req.query
			)
			return listUser
		} catch (error) {
			return error
		}
	}

	/**
	 * Creates a new user record if one doesn't already exist.
	 * Intended to be used after user login to register them in the system.
	 * @method
	 * @name create
	 * @param {Object} req - Request object.
	 * @param {Object} req.decodedToken - Decoded token object from authenticated user.
	 * @returns {JSON} - Success or failure message.
	 */
	async create(req) {
		try {
			return await userService.create(
				req.decodedToken,
				req.decodedToken.id,
				req.decodedToken.organization_code,
				req.decodedToken.tenant_code
			)
		} catch (error) {
			return error
		}
	}

	/**
	 * Adds a new user to the system.
	 * Used by an admin or internal service to register users with full input.
	 * @method
	 * @name add
	 * @param {Object} req - Request object.
	 * @param {Object} req.body - User details (name, email, type, etc.)
	 * @returns {JSON} - Success or failure response.
	 */
	async add(req) {
		try {
			return await userService.add(
				req.body,
				req.body.id.toString(),
				req.body.organization_code,
				req.body.tenant_code
			)
		} catch (error) {
			return error
		}
	}

	/**
	 * Updates user details like name, role, or profile data.
	 * @method
	 * @name update
	 * @param {Object} req - Request object.
	 * @param {Object} req.body - Updated user details.
	 * @returns {JSON} - Update status and response data.
	 */
	async update(req) {
		try {
			// For internal calls, construct minimal decodedToken object with required properties
			const decodedToken = req.decodedToken || {
				id: req.body.id.toString(),
				tenant_code: req.body.tenant_code,
				organization_id: req.body.organization_id || req.body.organization_code,
				organization_code: req.body.organization_code,
			}

			return await userService.update(
				req.body,
				decodedToken,
				req.body.id.toString(),
				req.body.organization_code,
				req.body.tenant_code
			)
		} catch (error) {
			return error
		}
	}

	/**
	 * Deletes a user by internal user ID.
	 * Only accessible to admin users.
	 * @method
	 * @name delete
	 * @param {Object} req - Request object.
	 * @param {String} req.body.id - Internal user ID to delete.
	 * @returns {JSON} - Deletion status and response.
	 */
	async delete(req) {
		try {
			// Check if req.body.id exists before calling toString()
			if (!req.body.id) {
				return responses.failureResponse({
					message: 'USER_ID_REQUIRED',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			// For internal calls, only req.body.id and req.body.tenant_code are available
			// Other parameters (currentUserId, organizationCode, token) will use defaults
			// Internal endpoint is admin-only, so pass isAdmin=true
			return await adminService.userDelete(
				req.body.id.toString(),
				null, // currentUserId - not available for internal calls
				null, // organizationCode - not available for internal calls
				req.body.tenant_code,
				'', // token defaults to '' in service method
				false // isAdmin - internal endpoint is admin-only
			)
		} catch (error) {
			return error
		}
	}

	/**
	 * Get user's connection and session request counts
	 * @method
	 * @name requestCount
	 * @param {Object} req - Request object.
	 * @returns {JSON} - Request counts with success/failure response.
	 */
	async requestCount(req) {
		try {
			return await userService.requestCount(req.decodedToken.id, req.decodedToken.tenant_code)
		} catch (error) {
			return error
		}
	}
}
