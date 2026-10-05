module.exports = {
	create: (req) => {
		req.checkBody('requestee_id').optional().isString().withMessage('requestee_id must be a string')

		req.checkBody('requestees').optional().isArray().withMessage('requestees must be an array')

		req.checkBody('title')
			.notEmpty()
			.withMessage('title is required')
			.isString()
			.withMessage('title must be a string')

		req.checkBody('agenda')
			.notEmpty()
			.withMessage('agenda is required')
			.isString()
			.withMessage('agenda must be a string')
			.custom((value) => {
				const wordCount = value.trim().split(/\s+/).length
				if (wordCount > 300) {
					throw new Error('agenda must be 300 words or fewer')
				}
				return true
			})

		req.checkBody('title')
			.optional()
			.trim()
			.notEmpty()
			.withMessage('title field is empty')
			.isString()
			.withMessage('title must be a string')
			.matches(/^[a-zA-Z0-9\-.,\s]+$/)
			.withMessage('invalid title')

		req.checkBody('start_date')
			.notEmpty()
			.withMessage('start_date field is required')
			.isInt()
			.withMessage('start_date must be an integer')

		req.checkBody('end_date')
			.notEmpty()
			.withMessage('end_date field is empty')
			.isInt()
			.withMessage('end_date must be an integer')

		req.checkBody('time_zone')
			.optional()
			.isString()
			.withMessage('time_zone must be a string')
			.matches(/^[a-zA-Z]+\/[a-zA-Z_]+$/)
			.withMessage('invalid time_zone ')
	},

	pendingList: (req) => {},

	list: (req) => {
		req.checkQuery('status')
			.optional()
			.custom((value) => {
				const allowedStatuses = ['REQUESTED', 'ACCEPTED', 'REJECTED', 'EXPIRED']

				// Allow comma-separated values
				const statuses = value.split(',').map((status) => status.trim())

				// Check if every status provided is valid
				const isValid = statuses.every((status) => allowedStatuses.includes(status))
				if (!isValid) {
					throw new Error('Status must be one or more of REQUESTED, ACCEPTED, REJECTED or EXPIRED')
				}

				return true
			})
	},

	getDetails: (req) => {
		req.checkQuery('request_session_id')
			.notEmpty()
			.withMessage('request_session_id is required')
			.isString()
			.withMessage('request_session_id must be a string')
	},

	accept: (req) => {
		req.checkBody('request_session_id')
			.notEmpty()
			.withMessage('request_session_id is required')
			.isString()
			.withMessage('request_session_id must be a string')
	},

	reject: (req) => {
		req.checkBody('request_session_id')
			.notEmpty()
			.withMessage('request_session_id is required')
			.isString()
			.withMessage('request_session_id must be a string')

		req.checkBody('reason')
			.optional()
			.isString()
			.withMessage('reason must be a string')
			.custom((value) => {
				const wordCount = value.trim().split(/\s+/).length
				if (wordCount > 50) {
					throw new Error('reason must be 50 words or fewer')
				}
				return true
			})
	},

	update: (req) => {
		req.checkBody('request_session_id')
			.notEmpty()
			.withMessage('request_session_id is required')
			.isString()
			.withMessage('request_session_id must be a string')

		req.checkBody('extra_information')
			.optional()
			.isString()
			.withMessage('extra_information must be a string')
			.custom((value) => {
				if (!value.trim()) {
					throw new Error('extra_information cannot be empty')
				}
				const wordCount = value.trim().split(/\s+/).length
				if (wordCount > 300) {
					throw new Error('extra_information must be 300 words or fewer')
				}
				return true
			})
	},

	userAvailability: (req) => {
		req.checkQuery('status')
			.optional()
			.custom((value) => {
				const allowedStatuses = ['PUBLISHED', 'COMPLETED', 'LIVE']

				// Allow comma-separated values
				const statuses = value.split(',').map((status) => status.trim())

				// Check if every status provided is valid
				const isValid = statuses.every((status) => allowedStatuses.includes(status))
				if (!isValid) {
					throw new Error('Status must be one or more of PUBLISHED, COMPLETED, or LIVE')
				}

				return true
			})
	},
}
