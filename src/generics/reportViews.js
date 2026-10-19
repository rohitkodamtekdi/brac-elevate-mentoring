'use strict'

/**
 * Tenant-wise report materialized views (dashboard / history / assets), separate from the
 * entity-type driven `{tenant}_m_sessions` view which only serves upcoming sessions.
 *
 *  - {tenant}_m_session_requests_report : one row per support request (Needed), with
 *                                         enrolled (Approved) and attended (Delivered) counts.
 *  - {tenant}_m_session_history         : one row per COMPLETED session, filterable by province / site.
 *  - {tenant}_m_support_assets          : one row per asset request, with estimated value and quantity.
 *
 * Province, site, categories (pillar), idp_tasks and support offering type are read from meta
 * (session.meta wins over session_request.meta). Province / site can be a string or an array.
 *
 * This file must not depend on app modules so that migrations can require it.
 */

const REPORT_VIEWS = [
	{ key: 'SessionRequestReport', suffix: 'm_session_requests_report', uniqueColumn: 'request_id' },
	{ key: 'SessionHistory', suffix: 'm_session_history', uniqueColumn: 'session_id' },
	{ key: 'SupportAssets', suffix: 'm_support_assets', uniqueColumn: 'request_id' },
]

const assertTenantCode = (tenantCode) => {
	if (!tenantCode || typeof tenantCode !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(tenantCode)) {
		throw new Error('Invalid tenant code for report view creation')
	}
}

const getReportViewName = (tenantCode, suffix) => `${tenantCode}_${suffix}`

// jsonb scalar / array -> text[]
const metaToTextArray = (metaAlias, key) => `
	CASE jsonb_typeof(${metaAlias}->'${key}')
		WHEN 'array' THEN ARRAY(SELECT jsonb_array_elements_text(${metaAlias}->'${key}'))
		WHEN 'string' THEN ARRAY[${metaAlias}->>'${key}']
		ELSE '{}'::text[]
	END`

// Enrolled = every attendee row (self ENROLLED or INVITED/assigned); attended = joined_at set
const attendeeCounts = `
	LEFT JOIN LATERAL (
		SELECT
			COUNT(*)::integer AS enrolled_count,
			COUNT(*) FILTER (WHERE sa.joined_at IS NOT NULL)::integer AS attended_count
		FROM public.session_attendees sa
		WHERE sa.session_id = s.id AND sa.tenant_code = s.tenant_code AND sa.deleted_at IS NULL
	) att ON true`

const buildRequestsReportQuery = (tenantCode, viewName) => `
	CREATE MATERIALIZED VIEW ${viewName} AS
	SELECT
		sr.id AS request_id,
		sr.tenant_code,
		sr.requestor_id,
		sr.requestee_id,
		sr.requestees,
		sr.assignment_type::text AS assignment_type,
		sr.status AS request_status,
		sr.title,
		sr.created_at AS requested_at,
		date_trunc('month', sr.created_at)::date AS request_month,
		s.id AS session_id,
		s.status AS session_status,
		s.mentor_id,
		s.seats_limit,
		s.start_date,
		s.end_date,
		s.completed_at,
		mm.meta->>'support_offering_type' AS support_offering_type,
		${metaToTextArray('mm.meta', 'provinces')} AS provinces,
		${metaToTextArray('mm.meta', 'sites')} AS sites,
		CASE WHEN COALESCE(cardinality(s.categories), 0) > 0 THEN s.categories::text[]
			ELSE ${metaToTextArray('mm.meta', 'categories')} END AS categories,
		${metaToTextArray('mm.meta', 'idp_tasks')} AS idp_tasks,
		COALESCE(att.enrolled_count, 0) AS enrolled_count,
		COALESCE(att.attended_count, 0) AS attended_count
	FROM public.session_request sr
	LEFT JOIN public.sessions s
		ON s.id::text = sr.session_id AND s.tenant_code = sr.tenant_code AND s.deleted_at IS NULL
	CROSS JOIN LATERAL (
		SELECT COALESCE(sr.meta::jsonb, '{}'::jsonb) || COALESCE(s.meta, '{}'::jsonb) AS meta
	) mm
	${attendeeCounts}
	WHERE sr.deleted_at IS NULL AND sr.tenant_code = '${tenantCode}'`

const buildSessionHistoryQuery = (tenantCode, viewName) => `
	CREATE MATERIALIZED VIEW ${viewName} AS
	SELECT
		s.id AS session_id,
		s.tenant_code,
		s.title,
		s.type,
		s.status,
		s.mentor_id,
		s.mentor_name,
		s.mentor_organization_id,
		s.start_date,
		s.end_date,
		s.started_at,
		s.completed_at,
		(SELECT MIN(sr.id) FROM public.session_request sr
			WHERE sr.session_id = s.id::text AND sr.tenant_code = s.tenant_code AND sr.deleted_at IS NULL
		) AS request_id,
		s.meta->>'support_offering_type' AS support_offering_type,
		${metaToTextArray('s.meta', 'provinces')} AS provinces,
		${metaToTextArray('s.meta', 'sites')} AS sites,
		COALESCE(s.categories, '{}'::text[])::text[] AS categories,
		${metaToTextArray('s.meta', 'idp_tasks')} AS idp_tasks,
		COALESCE(att.enrolled_count, 0) AS enrolled_count,
		COALESCE(att.attended_count, 0) AS attended_count
	FROM public.sessions s
	${attendeeCounts}
	WHERE s.deleted_at IS NULL AND s.status = 'COMPLETED' AND s.tenant_code = '${tenantCode}'`

/**
 * Asset requests: one row per session_request where support_offering_type = 'asset'.
 * Monetary fields (estimated_value, quantity, total_value) are extracted from merged meta.
 * coach = requestor_id (LC who requested), mentor = requestee_id (SP who provides).
 */
const buildSupportAssetsQuery = (tenantCode, viewName) => `
	CREATE MATERIALIZED VIEW ${viewName} AS
	SELECT
		sr.id AS request_id,
		sr.tenant_code,
		sr.requestor_id,
		sr.requestee_id,
		sr.status AS request_status,
		sr.title,
		sr.created_at AS requested_at,
		date_trunc('month', sr.created_at)::date AS request_month,
		s.id AS session_id,
		s.status AS session_status,
		s.mentor_id,
		mm.meta->>'support_offering_type' AS support_offering_type,
		NULLIF(mm.meta->>'estimatedValue', '')::numeric AS estimated_value,
		NULLIF(mm.meta->>'quantity', '')::integer AS quantity,
		COALESCE(NULLIF(mm.meta->>'estimatedValue', '')::numeric, 0) *
			COALESCE(NULLIF(mm.meta->>'quantity', '')::integer, 0) AS total_value,
		mm.meta->>'assetType' AS asset_type,
		mm.meta->>'livelihoodCategory' AS livelihood_category,
		mm.meta->>'assetDescription' AS asset_description,
		${metaToTextArray('mm.meta', 'provinces')} AS provinces,
		${metaToTextArray('mm.meta', 'sites')} AS sites
	FROM public.session_request sr
	LEFT JOIN public.sessions s
		ON s.id::text = sr.session_id AND s.tenant_code = sr.tenant_code AND s.deleted_at IS NULL
	CROSS JOIN LATERAL (
		SELECT COALESCE(sr.meta::jsonb, '{}'::jsonb) || COALESCE(s.meta, '{}'::jsonb) AS meta
	) mm
	WHERE sr.deleted_at IS NULL AND sr.tenant_code = '${tenantCode}'
		AND (mm.meta->>'support_offering_type') = 'asset'`

const builders = {
	SessionRequestReport: buildRequestsReportQuery,
	SessionHistory: buildSessionHistoryQuery,
	SupportAssets: buildSupportAssetsQuery,
}

const indexQueries = (tenantCode, { key, suffix, uniqueColumn }) => {
	const viewName = getReportViewName(tenantCode, suffix)
	const queries = [`CREATE UNIQUE INDEX IF NOT EXISTS ${viewName}_uidx ON ${viewName} (${uniqueColumn});`]

	if (key === 'SessionRequestReport') {
		queries.push(
			`CREATE INDEX IF NOT EXISTS ${viewName}_month_idx ON ${viewName} (request_month);`,
			`CREATE INDEX IF NOT EXISTS ${viewName}_type_idx ON ${viewName} (support_offering_type);`,
			`CREATE INDEX IF NOT EXISTS ${viewName}_requestee_idx ON ${viewName} (requestee_id);`
		)
	} else if (key === 'SupportAssets') {
		queries.push(
			`CREATE INDEX IF NOT EXISTS ${viewName}_month_idx ON ${viewName} (request_month);`,
			`CREATE INDEX IF NOT EXISTS ${viewName}_requestee_idx ON ${viewName} (requestee_id);`,
			`CREATE INDEX IF NOT EXISTS ${viewName}_requestor_idx ON ${viewName} (requestor_id);`
		)
	} else {
		// SessionHistory
		queries.push(
			`CREATE INDEX IF NOT EXISTS ${viewName}_mentor_idx ON ${viewName} (mentor_id);`,
			`CREATE INDEX IF NOT EXISTS ${viewName}_start_idx ON ${viewName} (start_date);`
		)
	}

	// Province / site GIN indexes on all views
	queries.push(
		`CREATE INDEX IF NOT EXISTS ${viewName}_provinces_idx ON ${viewName} USING gin (provinces);`,
		`CREATE INDEX IF NOT EXISTS ${viewName}_sites_idx ON ${viewName} USING gin (sites);`
	)

	// Categories and idp_tasks GIN indexes on the two session-based views
	if (key === 'SessionRequestReport' || key === 'SessionHistory') {
		queries.push(
			`CREATE INDEX IF NOT EXISTS ${viewName}_categories_idx ON ${viewName} USING gin (categories);`,
			`CREATE INDEX IF NOT EXISTS ${viewName}_idptasks_idx ON ${viewName} USING gin (idp_tasks);`
		)
	}

	return queries
}

/**
 * Create (or recreate) all report views for a tenant. `sequelize` is a Sequelize instance
 * (or queryInterface.sequelize); `transaction` is optional.
 */
const createReportViews = async (sequelize, tenantCode, { transaction, recreate = false } = {}) => {
	assertTenantCode(tenantCode)
	for (const view of REPORT_VIEWS) {
		const viewName = getReportViewName(tenantCode, view.suffix)
		await sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS ${viewName};`, { transaction })
		await sequelize.query(builders[view.key](tenantCode, viewName), { transaction })
		for (const query of indexQueries(tenantCode, view)) await sequelize.query(query, { transaction })
	}
}

const dropReportViews = async (sequelize, tenantCode, { transaction } = {}) => {
	assertTenantCode(tenantCode)
	for (const view of REPORT_VIEWS) {
		await sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS ${getReportViewName(tenantCode, view.suffix)};`, {
			transaction,
		})
	}
}

const refreshReportViews = async (sequelize, tenantCode) => {
	assertTenantCode(tenantCode)
	for (const view of REPORT_VIEWS) {
		await sequelize.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${getReportViewName(tenantCode, view.suffix)}`)
	}
}

module.exports = {
	REPORT_VIEWS,
	getReportViewName,
	createReportViews,
	dropReportViews,
	refreshReportViews,
}
