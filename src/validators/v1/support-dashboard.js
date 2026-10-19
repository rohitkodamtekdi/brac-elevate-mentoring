const dateRule = (req, field) =>
	req.checkQuery(field).optional().isISO8601().withMessage(`${field} must be a date in YYYY-MM-DD format`)

module.exports = {
	summary: (req) => {
		dateRule(req, 'start_date')
		dateRule(req, 'end_date')
	},
	history: (req) => {
		dateRule(req, 'start_date')
		dateRule(req, 'end_date')
	},
}
