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

// Support category of a request (meta.support_offering_type); older requests without it are trainings
const REQUEST_CATEGORY_SQL = `CASE
	WHEN sr.meta::jsonb ->> 'support_offering_type' IN ('additional_service', 'asset')
		THEN sr.meta::jsonb ->> 'support_offering_type'
	ELSE 'training'
END`

// Sums [{ category, count }] rows to { training: 0, additional_service: 0, asset: 0 }
const countsByCategory = (rows) =>
	rows.reduce(
		(acc, row) => {
			acc[row.category] += row.count
			return acc
		},
		{ training: 0, additional_service: 0, asset: 0 }
	)
exports.countsByCategory = countsByCategory

// Dashboard filters on a request: province and site (meta.provinces / meta.sites arrays) and support category
// Returns { sql, replacements } - sql is appended to the WHERE clause
const requestFilters = (filters = {}) => {
	const conditions = []
	const replacements = {}
	if (filters.province) {
		conditions.push(`sr.meta::jsonb -> 'provinces' @> jsonb_build_array(CAST(:filterProvince AS text))`)
		replacements.filterProvince = filters.province
	}
	if (filters.site) {
		conditions.push(`sr.meta::jsonb -> 'sites' @> jsonb_build_array(CAST(:filterSite AS text))`)
		replacements.filterSite = filters.site
	}
	if (filters.type) {
		conditions.push(`${REQUEST_CATEGORY_SQL} = :filterCategory`)
		replacements.filterCategory = filters.type
	}
	return { sql: conditions.map((condition) => `AND ${condition}`).join('\n'), replacements }
}

// Open session requests per category - no session created yet and status REQUESTED
exports.getOpenRequestsCount = async (tenantCode, filters) => {
	try {
		const filter = requestFilters(filters)
		const query = `
			SELECT ${REQUEST_CATEGORY_SQL} AS category, COUNT(*)::int AS count
			FROM session_request sr
			WHERE sr.tenant_code = :tenantCode
				AND sr.status = :requestedStatus
				AND (sr.session_id IS NULL OR sr.session_id = '')
				AND sr.deleted_at IS NULL
				${filter.sql}
			GROUP BY 1
		`
		const rows = await sequelize.query(query, {
			type: QueryTypes.SELECT,
			replacements: { tenantCode, requestedStatus: common.CONNECTIONS_STATUS.REQUESTED, ...filter.replacements },
		})
		return countsByCategory(rows)
	} catch (error) {
		throw error
	}
}

// Province of a request (meta.provinces holds a single province id)
const REQUEST_PROVINCE_SQL = `sr.meta::jsonb -> 'provinces' ->> 0`

// Seats per category and province of the sessions created from the requests accepted by the user
// Returns [{ category, province_id, count }]
exports.getAcceptedRequestsSeatsCount = async (userId, tenantCode, filters) => {
	try {
		const filter = requestFilters(filters)
		const query = `
			SELECT ${REQUEST_CATEGORY_SQL} AS category, ${REQUEST_PROVINCE_SQL} AS province_id,
				COALESCE(SUM(s.seats_limit), 0)::int AS count
			FROM session_request sr
			INNER JOIN sessions s
				ON s.id::text = sr.session_id
				AND s.tenant_code = sr.tenant_code
				AND s.deleted_at IS NULL
			WHERE sr.tenant_code = :tenantCode
				AND sr.requestee_id = :userId
				AND sr.status = :acceptedStatus
				AND sr.deleted_at IS NULL
				${filter.sql}
			GROUP BY 1, 2
		`
		const rows = await sequelize.query(query, {
			type: QueryTypes.SELECT,
			replacements: {
				userId,
				tenantCode,
				acceptedStatus: common.CONNECTIONS_STATUS.ACCEPTED,
				...filter.replacements,
			},
		})
		return rows
	} catch (error) {
		throw error
	}
}

// Participants per category and province who joined the completed sessions created from the requests accepted by the user
// Returns [{ category, province_id, count }]
exports.getAcceptedRequestsDeliveredCount = async (userId, tenantCode, filters) => {
	try {
		const filter = requestFilters(filters)
		const query = `
			SELECT ${REQUEST_CATEGORY_SQL} AS category, ${REQUEST_PROVINCE_SQL} AS province_id,
				COUNT(DISTINCT (sa.session_id, sa.mentee_id))::int AS count
			FROM session_request sr
			INNER JOIN sessions s
				ON s.id::text = sr.session_id
				AND s.tenant_code = sr.tenant_code
				AND s.status = :completedStatus
				AND s.deleted_at IS NULL
			INNER JOIN session_attendees sa
				ON sa.session_id = s.id
				AND sa.tenant_code = s.tenant_code
				AND sa.joined_at IS NOT NULL
				AND sa.deleted_at IS NULL
			WHERE sr.tenant_code = :tenantCode
				AND sr.requestee_id = :userId
				AND sr.status = :acceptedStatus
				AND sr.deleted_at IS NULL
				${filter.sql}
			GROUP BY 1, 2
		`
		const rows = await sequelize.query(query, {
			type: QueryTypes.SELECT,
			replacements: {
				userId,
				tenantCode,
				acceptedStatus: common.CONNECTIONS_STATUS.ACCEPTED,
				completedStatus: common.COMPLETED_STATUS,
				...filter.replacements,
			},
		})
		return rows
	} catch (error) {
		throw error
	}
}

// Count and value of asset requests: approved (accepted by the user), delivered (accepted by the user and
// session completed) and pending (open requests). Value of a request = meta.estimatedValue x meta.quantity
exports.getAssetRequestsValues = async (userId, tenantCode) => {
	try {
		const numeric = (key, fallback) =>
			`CASE WHEN sr.meta::jsonb ->> '${key}' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (sr.meta::jsonb ->> '${key}')::numeric ELSE ${fallback} END`
		const requestValue = `${numeric('estimatedValue', 0)} * ${numeric('quantity', 1)}`
		const approved = `sr.status = :acceptedStatus AND sr.requestee_id = :userId`
		const delivered = `${approved} AND s.status = :completedStatus`
		const pending = `sr.status = :requestedStatus AND (sr.session_id IS NULL OR sr.session_id = '')`

		const query = `
			SELECT
				COUNT(*) FILTER (WHERE ${approved})::int AS approved_count,
				COALESCE(SUM(${requestValue}) FILTER (WHERE ${approved}), 0)::float AS approved_value,
				COUNT(*) FILTER (WHERE ${delivered})::int AS delivered_count,
				COALESCE(SUM(${requestValue}) FILTER (WHERE ${delivered}), 0)::float AS delivered_value,
				COUNT(*) FILTER (WHERE ${pending})::int AS pending_count,
				COALESCE(SUM(${requestValue}) FILTER (WHERE ${pending}), 0)::float AS pending_value
			FROM session_request sr
			LEFT JOIN sessions s
				ON s.id::text = sr.session_id
				AND s.tenant_code = sr.tenant_code
				AND s.deleted_at IS NULL
			WHERE sr.tenant_code = :tenantCode
				AND sr.meta::jsonb ->> 'support_offering_type' = 'asset'
				AND sr.deleted_at IS NULL
		`
		const [result] = await sequelize.query(query, {
			type: QueryTypes.SELECT,
			replacements: {
				userId,
				tenantCode,
				acceptedStatus: common.CONNECTIONS_STATUS.ACCEPTED,
				requestedStatus: common.CONNECTIONS_STATUS.REQUESTED,
				completedStatus: common.COMPLETED_STATUS,
			},
		})
		return {
			approved: { count: result.approved_count, value: result.approved_value },
			delivered: { count: result.delivered_count, value: result.delivered_value },
			pending: { count: result.pending_count, value: result.pending_value },
		}
	} catch (error) {
		throw error
	}
}
