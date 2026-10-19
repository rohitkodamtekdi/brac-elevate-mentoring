'use strict'

const { createReportViews, dropReportViews } = require('../../generics/reportViews')

const tenantQuery = `SELECT DISTINCT tenant_code FROM organization_extension WHERE tenant_code IS NOT NULL AND tenant_code != '' AND tenant_code != 'undefined'`

/**
 * Recreates the three report materialized views to:
 *   1. Add idp_tasks text[] column (with GIN index) to m_session_requests_report and m_session_history.
 *   2. Create the new m_support_assets view (one row per asset-type session request).
 *
 * createReportViews() always does DROP IF EXISTS + CREATE for every view in REPORT_VIEWS,
 * so calling it here is sufficient to apply all three changes at once.
 */
module.exports = {
	up: async (queryInterface) => {
		const sequelize = queryInterface.sequelize
		const [tenants] = await sequelize.query(tenantQuery)
		for (const { tenant_code } of tenants) {
			await createReportViews(sequelize, tenant_code, { recreate: true })
		}
	},

	down: async (queryInterface) => {
		const sequelize = queryInterface.sequelize
		const [tenants] = await sequelize.query(tenantQuery)
		for (const { tenant_code } of tenants) {
			await dropReportViews(sequelize, tenant_code)
		}
	},
}
