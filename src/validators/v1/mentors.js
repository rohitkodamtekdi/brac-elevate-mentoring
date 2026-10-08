/**
 * name : validators/v1/mentees.js
 * author : Aman Gupta
 * Date : 29-Nov-2021
 * Description : Validations of mentors controller
 */

module.exports = {
	reports: (req) => {
		// Dashboard scope numbers are not date based, so filterType is not needed for them
		if (req.query.scope) return

		req.checkQuery('filterType')
			.notEmpty()
			.withMessage('filterType query is empty')
			.isIn(['MONTHLY', 'WEEKLY', 'QUARTERLY'])
			.withMessage('filterType is invalid')
	},

	share: (req) => {
		req.checkParams('id').notEmpty().withMessage('id param is empty').isInt({ min: 0 })
	},

	upcomingSessions: (req) => {
		req.checkParams('id').notEmpty().withMessage('id param is empty')
		req.checkParams('menteeId').notEmpty().optional().withMessage('menteeId param is empty')
	},

	details: (req) => {
		req.checkParams('id').notEmpty().withMessage('id param is empty')
	},

	cancel: (req) => {
		req.checkParams('id').notEmpty().withMessage('id param is empty')
		req.checkBody('reason')
			.trim()
			.notEmpty()
			.withMessage('reason is required')
			.isString()
			.withMessage('reason must be a string')
			.isLength({ max: 500 })
			.withMessage('reason must be 500 characters or fewer')
	},
}
