const requestSession = require('@database/models/index').RequestSession
const { Op } = require('sequelize')
const sequelize = require('@database/models/index').sequelize

const common = require('@constants/common')
const MenteeExtension = require('@database/models/index').UserExtension
const { QueryTypes } = require('sequelize')
const moment = require('moment')
const { assign } = require('lodash')

exports.getColumns = async () => {
	try {
		return await Object.keys(requestSession.rawAttributes)
	} catch (error) {
		throw error
	}
}

exports.getModelName = async () => {
	try {
		return await requestSession.name
	} catch (error) {
		throw error
	}
}

exports.addSessionRequest = async (
	requestorId,
	requesteeId,
	Agenda,
	startDate,
	endDate,
	Title,
	Meta,
	tenantCode,
	assignment_type,
	requestees
) => {
	try {
		const SessionRequestData = [
			{
				requestor_id: requestorId,
				requestee_id: requesteeId || '',
				requestees: requestees,
				assignment_type: assignment_type,
				status: common.CONNECTIONS_STATUS.REQUESTED,
				title: Title,
				agenda: Agenda,
				start_date: startDate,
				end_date: endDate,
				created_by: requestorId,
				updated_by: requestorId,
				meta: Meta,
				tenant_code: tenantCode,
			},
		]

		const requests = await requestSession.bulkCreate(SessionRequestData)
		const requestResult = requests[0].get({ plain: true })

		return requestResult
	} catch (error) {
		throw error
	}
}

exports.getAllRequests = async (userId, status, tenantCode) => {
	try {
		// Prepare status filter
		const statusFilter =
			status.length != 0
				? status
				: {
						[Op.in]: [
							common.CONNECTIONS_STATUS.ACCEPTED,
							common.CONNECTIONS_STATUS.REQUESTED,
							common.CONNECTIONS_STATUS.REJECTED,
							common.CONNECTIONS_STATUS.EXPIRED,
						],
				  }

		const sessionRequest = await requestSession.findAndCountAll({
			where: {
				requestor_id: userId,
				status: statusFilter,
				tenant_code: tenantCode,
			},
			raw: true,
			order: [['created_at', 'DESC']],
		})

		return sessionRequest
	} catch (error) {
		throw error
	}
}

exports.getSessionMappingDetails = async (sessionRequestIds, status, tenantCode) => {
	try {
		const statusFilter =
			status != []
				? status
				: {
						[Op.in]: [
							common.CONNECTIONS_STATUS.ACCEPTED,
							common.CONNECTIONS_STATUS.REQUESTED,
							common.CONNECTIONS_STATUS.REJECTED,
							common.CONNECTIONS_STATUS.EXPIRED,
						],
				  }

		const result = await requestSession.findAll({
			where: {
				id: {
					[Op.in]: sessionRequestIds, // Using Sequelize.Op.in to filter by multiple ids
				},
				status: statusFilter, // Your status filter
				tenant_code: tenantCode,
			},
			order: [['created_at', 'DESC']],
		})

		return result
	} catch (error) {
		throw error
	}
}

exports.getpendingRequests = async (userId, page, pageSize, tenantCode) => {
	try {
		const currentPage = page ? page : 1
		const limit = pageSize ? pageSize : 5
		const offset = (currentPage - 1) * limit

		const result = await requestSession.findAndCountAll({
			where: {
				user_id: userId,
				status: common.CONNECTIONS_STATUS.REQUESTED,
				tenant_code: tenantCode,
			},
			raw: true,
			limit,
			offset,
		})

		return result
	} catch (error) {
		throw error
	}
}

exports.approveRequest = async (userId, requestSessionId, sessionId, tenantCode) => {
	try {
		const updateData = {
			requestee_id: userId,
			status: common.CONNECTIONS_STATUS.ACCEPTED,
			session_id: sessionId,
			updated_by: userId,
		}

		const requests = await requestSession.update(updateData, {
			where: {
				status: common.CONNECTIONS_STATUS.REQUESTED,
				id: requestSessionId,
				tenant_code: tenantCode,
			},
			individualHooks: true,
		})

		return requests[1] // this typically refers to the number of affected rows
	} catch (error) {
		throw error
	}
}

exports.rejectRequest = async (userId, requestSessionId, rejectReason, tenantCode) => {
	try {
		const sessionReq = await requestSession.findOne({
			where: {
				id: requestSessionId,
				tenant_code: tenantCode,
			},
			raw: true,
		})

		if (!sessionReq) {
			return [0, []]
		}

		const strUserId = String(userId)
		const currentRejected = Array.isArray(sessionReq.rejected_requestees) ? sessionReq.rejected_requestees : []
		const updatedRejected = Array.from(new Set([...currentRejected, strUserId]))

		let updateData = {
			updated_by: strUserId,
			reject_reason: rejectReason ? rejectReason : null,
			rejected_requestees: updatedRejected,
		}

		if (sessionReq.assignment_type === 'SPECIFIC') {
			updateData.requestee_id = userId
			updateData.status = common.CONNECTIONS_STATUS.REJECTED
		}

		return await requestSession.update(updateData, {
			where: {
				status: common.CONNECTIONS_STATUS.REQUESTED,
				id: requestSessionId,
				tenant_code: tenantCode,
			},
			individualHooks: true,
		})
	} catch (error) {
		throw error
	}
}

exports.expireRequest = async (requestSessionId, tenantCode, requestees = null) => {
	try {
		let updateData = {
			status: common.CONNECTIONS_STATUS.EXPIRED,
		}

		// If caller provides an updated requestees array, persist it
		if (Array.isArray(requestees)) {
			updateData.requestees = requestees
		}

		return await requestSession.update(updateData, {
			where: {
				status: common.CONNECTIONS_STATUS.REQUESTED,
				id: requestSessionId,
				tenant_code: tenantCode,
			},
			individualHooks: true,
		})
	} catch (error) {
		throw error
	}
}

exports.updateRequest = async (userId, requestSessionId, meta, tenantCode) => {
	try {
		return await requestSession.update(
			{ meta, updated_by: String(userId) },
			{
				where: {
					status: common.CONNECTIONS_STATUS.REQUESTED,
					id: requestSessionId,
					tenant_code: tenantCode,
				},
				returning: true,
			}
		)
	} catch (error) {
		throw error
	}
}

exports.findOneRequest = async (requestSessionId, tenantCode) => {
	try {
		const sessionRequest = await requestSession.findOne({
			where: {
				id: requestSessionId,
				status: common.CONNECTIONS_STATUS.REQUESTED,
				tenant_code: tenantCode,
			},
			raw: true,
		})

		return sessionRequest
	} catch (error) {
		throw error
	}
}

exports.checkPendingRequest = async (requestorId, requesteeId, tenantCode) => {
	try {
		const result = await requestSession.findAndCountAll({
			where: {
				requestor_id: requestorId,
				requestee_id: requesteeId,
				status: common.CONNECTIONS_STATUS.REQUESTED,
				tenant_code: tenantCode,
			},
		})
		return result
	} catch (error) {
		throw error
	}
}

exports.getRequestSessions = async (requestSessionId, tenantCode) => {
	try {
		const whereClause = {
			id: requestSessionId,
			tenant_code: tenantCode,
		}
		return await requestSession.findOne({
			where: whereClause,
			raw: true,
		})
	} catch (error) {
		throw error
	}
}

exports.markRequestsAsDeleted = async (requestSessionIds = [], tenantCode) => {
	try {
		const currentDateTime = moment().format('YYYY-MM-DD HH:mm:ssZ')

		const whereClause = {
			id: {
				[Op.in]: requestSessionIds,
			},
			tenant_code: tenantCode,
		}

		const [, updatedRows] = await requestSession.update(
			{
				deleted_at: currentDateTime,
			},
			{
				where: whereClause,
				returning: true, // Only works with PostgreSQL
			}
		)

		const deletedIds = updatedRows.map((row) => row.id)

		return deletedIds.length > 0
	} catch (error) {
		throw error
	}
}

exports.getPendingSessionRequests = async (userId, tenant_code) => {
	try {
		const query = `
			SELECT rs.*, rm.requestee_id as userId
			FROM session_request rs
			INNER JOIN session_request_mapping rm ON rs.id = rm.request_session_id
			WHERE rm.requestee_id = :userId 
			AND rm.tenant_code = :tenantCode
			AND rs.status = :requestedStatus
			AND rs.deleted_at IS NULL
		`

		const pendingRequests = await sequelize.query(query, {
			type: QueryTypes.SELECT,
			replacements: {
				userId,
				requestedStatus: common.CONNECTIONS_STATUS.REQUESTED,
				tenant_code: tenant_code,
			},
		})

		return pendingRequests || []
	} catch (error) {
		throw error
	}
}

exports.getCount = async (userId, status, tenantCode) => {
	try {
		// Prepare filter
		const filter =
			status.length != 0
				? status
				: {
						[Op.in]: [
							common.CONNECTIONS_STATUS.ACCEPTED,
							common.CONNECTIONS_STATUS.REQUESTED,
							common.CONNECTIONS_STATUS.REJECTED,
							common.CONNECTIONS_STATUS.EXPIRED,
						],
				  }

		const sessionRequest = await requestSession.count({
			where: {
				requestor_id: userId,
				status: filter,
				tenant_code: tenantCode,
			},
		})

		return sessionRequest
	} catch (error) {
		throw error
	}
}
