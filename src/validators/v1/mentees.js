/**
 * name : validators/v1/mentees.js
 * author : Aman Gupta
 * Date : 19-Nov-2021
 * Description : Validations of mentees controller
 */

module.exports = {
	sessions: (req) => {},
	attendedSessions: (req) => {
		req.checkQuery('userId').optional().isNumeric().withMessage('userId query is invalid, must be an integer')
	},
	homeFeed: (req) => {
		req.checkQuery('sessionScope')
			.optional()
			.custom((value) => {
				const validScopes = ['all', 'my']
				const scopes = value.split(',').map((s) => s.trim().toLowerCase())
				const invalidScopes = scopes.filter((s) => !validScopes.includes(s))
				if (invalidScopes.length > 0) {
					return false
				}
				return true
			})
			.withMessage('INVALID_SESSION_SCOPE')
	},

	reports: (req) => {
		req.checkQuery('filterType')
			.notEmpty()
			.withMessage('filterType query is empty')
			.isIn(['MONTHLY', 'WEEKLY', 'QUARTERLY'])
			.withMessage('filterType is invalid')
	},

	joinSession: (req) => {
		req.checkParams('id')
			.notEmpty()
			.withMessage('id param is empty')
			.isNumeric()
			.withMessage('id param is invalid, must be an integer')
	},
}
