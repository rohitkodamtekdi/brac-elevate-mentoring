// Dependencies
const httpStatusCode = require('@generics/http-status')
const responses = require('@helpers/responses')

const resourceQueries = require('@database/queries/resources')
const cacheHelper = require('@generics/cacheHelper')
const common = require('@constants/common')

module.exports = class SessionsHelper {
	/**
	 * Remove resources from session.
	 * @method
	 * @name deleteResource
	 * @param {String} resourceId 				- resource id.
	 * @param {String} sessionId 				- Session id.
	 * @returns {JSON} 							- deleted response
	 */

	static async deleteResource(resourceId, sessionId, userId, organizationId, tenantCode) {
		try {
			// Validate resource belongs to the specified session and delete it
			const deletedRows = await resourceQueries.deleteResourceByIdWithSessionValidation(
				resourceId,
				sessionId,
				tenantCode
			)

			if (deletedRows === 0) {
				return responses.failureResponse({
					message: 'RESOURCE_NOT_FOUND_OR_SESSION_INVALID',
					statusCode: httpStatusCode.bad_request,
					responseCode: 'CLIENT_ERROR',
				})
			}

			// Invalidate session cache after deleting resource
			try {
				await cacheHelper.sessions.delete(tenantCode, sessionId)
			} catch (cacheError) {
				console.log('Error in invalidating session cache:', cacheError)
				// Cache invalidation failure - continue operation
			}

			return responses.successResponse({
				statusCode: httpStatusCode.created,
				message: 'RESOURCE_DELETED_SUCCESSFULLY',
			})
		} catch (error) {
			throw error
		}
	}

	/**
	 * List resources for a session.
	 * @method
	 * @name listResources
	 * @param {String} type 					- Resource type.
	 * @param {String} sessionId 				- Session id.
	 * @returns {JSON} 							- List of resources
	 */

	static async listResources(mimetype, type, sessionId, userId, tenantCode) {
		try {
			let filter = { status: common.ACTIVE_STATUS }
			if (mimetype) {
				filter.mime_type = mimetype
			}
			if (type) {
				filter.type = type
			}
			if (sessionId) {
				filter.session_id = sessionId
			}

			// Fetch resources for the specified session and type
			const resources = await resourceQueries.findWithSession(filter, tenantCode)
			if (resources instanceof Error) throw resources
			console.log('Resources fetched:', resources)
			return responses.successResponse({
				statusCode: httpStatusCode.ok,
				message: 'RESOURCES_FETCHED_SUCCESSFULLY',
				result: resources && resources.length > 0 ? resources : [],
			})
		} catch (error) {
			return responses.failureResponse({
				message: 'ERROR_FETCHING_RESOURCES',
				statusCode: httpStatusCode.internal_server_error,
				responseCode: 'SERVER_ERROR',
			})
		}
	}
}
