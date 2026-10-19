'use strict'

const supportDashboardService = require('@services/support-dashboard')

const VALID_VIEWS = ['summary', 'by_mentor', 'assets']

module.exports = class SupportDashboard {
	/**
	 * Unified Support Provider dashboard endpoint.
	 * Pass `view` to select the data slice returned:
	 *   - summary   (default) – Needed / Approved / Delivered / Committed totals, by-type
	 *                           breakdown, monthly chart, sessions per province.
	 *   - by_mentor           – Intervention counts aggregated per support provider.
	 *   - assets              – Asset requests with totals and paginated row listing.
	 *
	 * @method
	 * @name data
	 * @param {Object} req.query - view (summary|by_mentor|assets, default: summary)
	 *                             provinces, sites, pillar, idp_tasks (comma-separated),
	 *                             support_offering_type, mentor_id, start_date, end_date,
	 *                             page, limit  (page/limit apply to assets view only)
	 * @returns {JSON} - Shape depends on view (see service methods for details).
	 */
	async data(req) {
		try {
			const view = VALID_VIEWS.includes(req.query.view) ? req.query.view : 'summary'
			if (view === 'by_mentor') {
				return await supportDashboardService.byMentor(req.query, req.decodedToken.tenant_code)
			}
			if (view === 'assets') {
				return await supportDashboardService.assets(
					req.query,
					req.decodedToken.tenant_code,
					req.pageNo,
					req.pageSize
				)
			}
			return await supportDashboardService.summary(req.query, req.decodedToken.tenant_code)
		} catch (error) {
			return error
		}
	}

	/**
	 * History of completed sessions in the user's province and site.
	 * Province / site default to the logged-in user's profile; query params override them.
	 * @method
	 * @name history
	 * @param {Object} req.query - provinces, sites, pillar, idp_tasks, support_offering_type,
	 *                             start_date, end_date, page, limit
	 * @returns {JSON} - Paginated session history.
	 */
	async history(req) {
		try {
			return await supportDashboardService.history(
				req.query,
				req.decodedToken.id,
				req.decodedToken.tenant_code,
				req.pageNo,
				req.pageSize
			)
		} catch (error) {
			return error
		}
	}
}
