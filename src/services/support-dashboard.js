'use strict'

const httpStatusCode = require('@generics/http-status')
const responses = require('@helpers/responses')
const { sequelize } = require('@database/models/index')
const { QueryTypes } = require('sequelize')
const { getReportViewName, REPORT_VIEWS } = require('@generics/reportViews')

const viewName = (tenantCode, key) => getReportViewName(tenantCode, REPORT_VIEWS.find((v) => v.key === key).suffix)

const toList = (value) =>
	value
		? String(value)
				.split(',')
				.map((v) => v.trim())
				.filter(Boolean)
		: []

const assertTenant = (tenantCode) => {
	if (!tenantCode || !/^[a-zA-Z0-9_-]+$/.test(tenantCode)) throw new Error('Invalid tenant code')
}

const run = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT })

/**
 * Builds WHERE conditions.
 * dateColumn is a timestamp expression — history view stores epoch seconds so callers pass
 * to_timestamp(start_date); request report uses requested_at directly.
 */
const buildFilters = (query, { provinces, sites, pillars, idpTasks }, dateColumn) => {
	const conditions = []
	const replacements = {}
	if (provinces?.length) {
		conditions.push('provinces && ARRAY[:provinces]::text[]')
		replacements.provinces = provinces
	}
	if (sites?.length) {
		conditions.push('sites && ARRAY[:sites]::text[]')
		replacements.sites = sites
	}
	if (pillars?.length) {
		conditions.push('categories && ARRAY[:pillars]::text[]')
		replacements.pillars = pillars
	}
	if (idpTasks?.length) {
		conditions.push('idp_tasks && ARRAY[:idpTasks]::text[]')
		replacements.idpTasks = idpTasks
	}
	if (query.support_offering_type) {
		conditions.push('support_offering_type = :supportOfferingType')
		replacements.supportOfferingType = query.support_offering_type
	}
	if (query.mentor_id) {
		conditions.push('mentor_id = :mentorId')
		replacements.mentorId = query.mentor_id
	}
	if (query.start_date) {
		conditions.push(`${dateColumn} >= :startDate::date`)
		replacements.startDate = query.start_date
	}
	if (query.end_date) {
		conditions.push(`${dateColumn} < (:endDate::date + 1)`)
		replacements.endDate = query.end_date
	}
	return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', replacements }
}

/**
 * Committed capacity from the mentor extension table.
 * Province / site / date filters are NOT stored on the extension, so we accept an optional
 * `mentorIds` array (pre-derived from the filtered request view) to scope the sum.
 * "training" returns committed_sessions only; anything else returns all three.
 */
const getCommittedCounts = async (query, tenantCode, mentorIds = null) => {
	const trainingOnly = String(query.support_offering_type || '').toLowerCase() === 'training'
	const columns = trainingOnly
		? ['committed_sessions']
		: ['committed_sessions', 'committed_assets', 'committed_services']
	const replacements = { tenantCode }
	let mentorFilter = ''

	if (query.mentor_id) {
		mentorFilter = 'AND user_id = :mentorId'
		replacements.mentorId = String(query.mentor_id)
	} else if (mentorIds?.length) {
		mentorFilter = 'AND user_id::text = ANY(ARRAY[:mentorIds]::text[])'
		replacements.mentorIds = mentorIds.map(String)
	}

	const sums = columns.map((c) => `COALESCE(SUM(NULLIF(TRIM(${c}::text), '')::numeric), 0)::int AS ${c}`).join(', ')

	const [row] = await run(
		`SELECT ${sums} FROM brac_m_user_extensions WHERE tenant_code = :tenantCode AND deleted_at IS NULL ${mentorFilter}`,
		replacements
	)
	// Always return all three keys for a consistent shape regardless of trainingOnly
	return {
		committed_sessions: row?.committed_sessions ?? 0,
		committed_assets: row?.committed_assets ?? 0,
		committed_services: row?.committed_services ?? 0,
	}
}

module.exports = class SupportDashboardService {
	/**
	 * Support Provider dashboard: Needed / Approved / Delivered / Committed totals,
	 * split by support offering type, month-on-month, and completed sessions per province.
	 * Query params: start_date, end_date, provinces, sites, pillar, idp_tasks,
	 *               support_offering_type, mentor_id (all optional, comma-separated where applicable)
	 */
	static async summary(query, tenantCode) {
		assertTenant(tenantCode)
		const requests = viewName(tenantCode, 'SessionRequestReport')
		const history = viewName(tenantCode, 'SessionHistory')
		const filters = {
			provinces: toList(query.provinces),
			sites: toList(query.sites),
			pillars: toList(query.pillar),
			idpTasks: toList(query.idp_tasks),
		}

		const req = buildFilters(query, filters, 'requested_at')
		const ses = buildFilters(query, filters, 'to_timestamp(start_date)')

		// Interventions Overview covers sessions and services only — assets are in their own tab.
		// Inject this exclusion into every query that reads from the requests view.
		const withoutAssets = (where) =>
			where ? `${where} AND support_offering_type != 'asset'` : "WHERE support_offering_type != 'asset'"
		const reqWhere = withoutAssets(req.where)

		const aggregate = `COUNT(*)::int AS needed,
			COALESCE(SUM(seats_limit), 0)::int AS approved,
			COALESCE(SUM(attended_count), 0)::int AS delivered`

		const [requestTotals] = await run(`SELECT ${aggregate} FROM ${requests} ${reqWhere}`, req.replacements)

		// Province-scope the committed count: when province/site filters are active (but no explicit
		// mentor_id), first find which mentors have requests in those provinces, then sum their
		// committed values — brac_m_user_extensions has no province column of its own.
		let committedMentorIds = null
		if (!query.mentor_id && (filters.provinces.length || filters.sites.length)) {
			const mentorRows = await run(`SELECT DISTINCT mentor_id FROM ${requests} ${reqWhere}`, req.replacements)
			committedMentorIds = mentorRows.map((r) => r.mentor_id).filter(Boolean)
		}

		const committed = await getCommittedCounts(query, tenantCode, committedMentorIds)
		const totals = { ...requestTotals, ...committed }

		const byType = await run(
			`SELECT COALESCE(support_offering_type, 'unspecified') AS support_offering_type, ${aggregate}
			 FROM ${requests} ${reqWhere} GROUP BY 1 ORDER BY 1`,
			req.replacements
		)
		const monthly = await run(
			`SELECT to_char(request_month, 'YYYY-MM') AS month, ${aggregate}
			 FROM ${requests} ${reqWhere} GROUP BY request_month ORDER BY request_month`,
			req.replacements
		)
		// A session in several provinces counts once under each of them
		const perProvince = await run(
			`SELECT province, COUNT(DISTINCT session_id)::int AS sessions_completed
			 FROM ${history}, unnest(provinces) AS province ${ses.where} GROUP BY province ORDER BY sessions_completed DESC`,
			ses.replacements
		)

		// Approved vs delivered per province; a request in several provinces counts under each of them
		const byProvince = await run(
			`SELECT province, ${aggregate}
			 FROM ${requests}, unnest(provinces) AS province ${reqWhere} GROUP BY province ORDER BY approved DESC`,
			req.replacements
		)

		return responses.successResponse({
			statusCode: httpStatusCode.ok,
			message: 'SUPPORT_DASHBOARD_FETCHED_SUCCESSFULLY',
			result: {
				totals,
				by_support_offering_type: byType,
				monthly,
				sessions_per_province: perProvince,
				by_province: byProvince,
			},
		})
	}

	/**
	 * History of completed sessions, defaulting to the logged-in user's province + site.
	 * Query params: provinces, sites, pillar, idp_tasks, support_offering_type,
	 *               start_date, end_date, page, limit
	 */
	static async history(query, userId, tenantCode, page, limit) {
		assertTenant(tenantCode)
		const history = viewName(tenantCode, 'SessionHistory')

		let provinces = toList(query.provinces)
		let sites = toList(query.sites)
		if (!provinces.length && !sites.length) {
			// Default to the logged-in user's own province and site
			const [user] = await run(
				`SELECT meta FROM user_extensions WHERE user_id = :userId AND tenant_code = :tenantCode AND deleted_at IS NULL LIMIT 1`,
				{ userId: String(userId), tenantCode }
			)
			const asList = (v) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : [])
			provinces = asList(user?.meta?.provinces)
			sites = asList(user?.meta?.sites)
		}

		const { where, replacements } = buildFilters(
			query,
			{ provinces, sites, pillars: toList(query.pillar), idpTasks: toList(query.idp_tasks) },
			'to_timestamp(start_date)'
		)
		const [{ count }] = await run(`SELECT COUNT(*)::int AS count FROM ${history} ${where}`, replacements)
		const rows = await run(
			`SELECT * FROM ${history} ${where} ORDER BY start_date DESC LIMIT :limit OFFSET :offset`,
			{ ...replacements, limit, offset: (page - 1) * limit }
		)

		return responses.successResponse({
			statusCode: httpStatusCode.ok,
			message: 'SUPPORT_SESSION_HISTORY_FETCHED_SUCCESSFULLY',
			result: { data: rows, count, applied_filters: { provinces, sites } },
		})
	}

	/**
	 * Aggregated intervention counts per support provider (mentor / SP).
	 * Groups the session request report by requestee_id; each group carries needed /
	 * approved / delivered counts plus the mentor's committed figures.
	 * Supports the same filters as summary (provinces, sites, pillar, idp_tasks,
	 * support_offering_type, start_date, end_date, mentor_id).
	 */
	static async byMentor(query, tenantCode) {
		assertTenant(tenantCode)
		const requests = viewName(tenantCode, 'SessionRequestReport')
		const filters = {
			provinces: toList(query.provinces),
			sites: toList(query.sites),
			pillars: toList(query.pillar),
			idpTasks: toList(query.idp_tasks),
		}
		const { where, replacements } = buildFilters(query, filters, 'requested_at')

		// Exclude rows with no assigned provider — those requests haven't been accepted yet.
		// requestee_id can be NULL, 0 (integer), or '' (empty string) for unassigned requests.
		const byMentorWhere = where
			? `${where} AND TRIM(COALESCE(requestee_id::text, '')) NOT IN ('', '0')`
			: `WHERE TRIM(COALESCE(requestee_id::text, '')) NOT IN ('', '0')`

		const coalesce = (col) => `COALESCE(NULLIF(TRIM(ext.${col}::text), '')::numeric, 0)::int`

		const rows = await run(
			`SELECT
				r.mentor_id,
				r.needed,
				r.approved,
				r.delivered,
				r.delivered_sessions,
				r.delivered_services,
				r.delivered_assets,
				${coalesce('committed_sessions')} AS committed_sessions,
				${coalesce('committed_services')} AS committed_services,
				${coalesce('committed_assets')}   AS committed_assets
			FROM (
				SELECT
					requestee_id AS mentor_id,
					COUNT(*)::int AS needed,
					COALESCE(SUM(seats_limit), 0)::int AS approved,
					COALESCE(SUM(attended_count), 0)::int AS delivered,
					COALESCE(SUM(attended_count) FILTER (WHERE support_offering_type = 'training'), 0)::int          AS delivered_sessions,
					COALESCE(SUM(attended_count) FILTER (WHERE support_offering_type = 'additional_service'), 0)::int AS delivered_services,
					COALESCE(SUM(attended_count) FILTER (WHERE support_offering_type = 'asset'), 0)::int             AS delivered_assets
				FROM ${requests} ${byMentorWhere}
				GROUP BY requestee_id
				ORDER BY needed DESC
			) r
			LEFT JOIN brac_m_user_extensions ext
				ON ext.user_id::text = r.mentor_id::text
				AND ext.tenant_code = :tenantCode
				AND ext.deleted_at IS NULL
			ORDER BY r.needed DESC`,
			{ ...replacements, tenantCode }
		)

		return responses.successResponse({
			statusCode: httpStatusCode.ok,
			message: 'SUPPORT_BY_MENTOR_FETCHED_SUCCESSFULLY',
			result: rows,
		})
	}

	/**
	 * Asset requests: totals (total_value, quantity) and paginated row listing.
	 * Filters: provinces, sites, start_date, end_date, mentor_id (all optional).
	 * Note: assets view has no idp_tasks / pillar columns — those filters are ignored here.
	 */
	static async assets(query, tenantCode, page, limit) {
		assertTenant(tenantCode)
		const assets = viewName(tenantCode, 'SupportAssets')

		const conditions = []
		const replacements = {}
		const provinces = toList(query.provinces)
		const sites = toList(query.sites)

		if (provinces.length) {
			conditions.push('provinces && ARRAY[:provinces]::text[]')
			replacements.provinces = provinces
		}
		if (sites.length) {
			conditions.push('sites && ARRAY[:sites]::text[]')
			replacements.sites = sites
		}
		if (query.mentor_id) {
			conditions.push('mentor_id = :mentorId')
			replacements.mentorId = query.mentor_id
		}
		if (query.start_date) {
			conditions.push('requested_at >= :startDate::date')
			replacements.startDate = query.start_date
		}
		if (query.end_date) {
			conditions.push('requested_at < (:endDate::date + 1)')
			replacements.endDate = query.end_date
		}

		const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

		const [totals] = await run(
			`WITH a AS (SELECT * FROM ${assets} ${where})
			SELECT
				COUNT(*)::int AS total_requests,
				COALESCE(SUM(a.quantity), 0)::int AS total_quantity,
				COALESCE(SUM(a.total_value), 0)::numeric AS total_value,
				COUNT(*) FILTER (WHERE a.session_id IS NOT NULL)::int AS approved_count,
				COALESCE(SUM(
					CASE WHEN a.session_id IS NOT NULL
						THEN COALESCE(a.estimated_value, 0) * COALESCE(s.seats_limit, 0)
						ELSE 0 END
				), 0)::numeric AS approved_value,
				COALESCE(SUM(
					COALESCE(a.estimated_value, 0) * COALESCE(att.attended_count, 0)
				), 0)::numeric AS delivered_value
			FROM a
			LEFT JOIN public.sessions s ON s.id = a.session_id AND s.deleted_at IS NULL
			LEFT JOIN LATERAL (
				SELECT COUNT(*) FILTER (WHERE sa.joined_at IS NOT NULL)::integer AS attended_count
				FROM public.session_attendees sa
				WHERE sa.session_id = s.id AND sa.tenant_code = s.tenant_code AND sa.deleted_at IS NULL
			) att ON true`,
			replacements
		)
		const [{ count }] = await run(`SELECT COUNT(*)::int AS count FROM ${assets} ${where}`, replacements)
		const rows = await run(
			`SELECT * FROM ${assets} ${where} ORDER BY requested_at DESC LIMIT :limit OFFSET :offset`,
			{ ...replacements, limit, offset: (page - 1) * limit }
		)

		return responses.successResponse({
			statusCode: httpStatusCode.ok,
			message: 'SUPPORT_ASSETS_FETCHED_SUCCESSFULLY',
			result: { totals, data: rows, count },
		})
	}
}
