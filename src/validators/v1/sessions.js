/**
 * name : validators/v1/entity.js
 * author : Aman Gupta
 * Date : 04-Nov-2021
 * Description : Validations of user entities controller
 */
const { filterRequestBody } = require('../common')
const { sessions } = require('@constants/blacklistConfig')
const common = require('@constants/common')
module.exports = {
	update: (req) => {
		req.body = filterRequestBody(req.body, sessions.update)

		// SkipValidation=true (e.g. saving a draft) only needs a title; the remaining required fields are enforced on publish
		const SkipValidation = String(req.query.SkipValidation).toLowerCase() === 'true'
		const skipOptional = (chain) => (SkipValidation ? chain.optional({ checkFalsy: true }) : chain)

		if (!req.params.id) {
			req.checkBody('title')
				.trim()
				.notEmpty()
				.withMessage('title field is empty')
				.isString()
				.withMessage('title must be a string')
				.matches(/^[a-zA-Z0-9\-.,\s]+$/)
				.withMessage('invalid title')

			skipOptional(req.checkBody('description'))
				.trim()
				.notEmpty()
				.withMessage('description field is empty')
				.isString()
				.withMessage('description must be a string')
				.matches(/^[a-zA-Z0-9\-.,\s]+$/)
				.withMessage('invalid description')

			req.checkBody('medium').optional().isArray({ min: 1 }).withMessage('medium must be an array')

			req.checkBody('image').optional().isArray().withMessage('image must be an array')

			req.checkBody('mentor_id').optional().isInt().withMessage('mentor_id must be an integer')

			req.checkBody('mentees').optional().isArray().withMessage('mentees must be an array')

			req.checkBody('time_zone')
				.optional()
				.isString()
				.withMessage('time_zone must be a string')
				.matches(/^[a-zA-Z]+\/[a-zA-Z_]+$/)
				.withMessage('invalid time_zone ')

			skipOptional(req.checkBody('start_date'))
				.notEmpty()
				.withMessage('start_date field is required')
				.isInt()
				.withMessage('start_date must be an integer')

			skipOptional(req.checkBody('end_date'))
				.notEmpty()
				.withMessage('end_date field is empty')
				.isInt()
				.withMessage('end_date must be an integer')

			req.checkBody('type').optional().isString().withMessage('type must be a string')

			req.checkBody('status')
				.optional()
				.isIn([common.DRAFT_STATUS, common.PUBLISHED_STATUS])
				.withMessage('status must be one of DRAFT, PUBLISHED')
		} else {
			req.checkBody('title')
				.optional()
				.trim()
				.notEmpty()
				.withMessage('title field is empty')
				.isString()
				.withMessage('title must be a string')
				.matches(/^[a-zA-Z0-9\-.,\s]+$/)
				.withMessage('invalid title')

			req.checkBody('description')
				.optional({ checkFalsy: SkipValidation })
				.trim()
				.notEmpty()
				.withMessage('description field is empty')
				.isString()
				.withMessage('description must be a string')
				.matches(/^[a-zA-Z0-9\-.,\s]+$/)
				.withMessage('invalid description')

			req.checkBody('medium')
				.optional()
				.notEmpty()
				.withMessage('medium field is empty')
				.isArray({ min: 1 })
				.withMessage('medium must be an array')

			req.checkBody('image').optional().isArray().withMessage('image must be an array')

			req.checkBody('mentor_id').optional().isInt().withMessage('mentor_id must be an integer')

			req.checkBody('mentees').optional().isArray().withMessage('mentees must be an array')

			req.checkBody('time_zone')
				.optional()
				.isString()
				.withMessage('time_zone must be a string')
				.matches(/^[a-zA-Z]+\/[a-zA-Z_]+$/)
				.withMessage('invalid time_zone ')

			req.checkBody('start_date')
				.optional({ checkFalsy: SkipValidation })
				.notEmpty()
				.withMessage('start_date field is required')
				.isInt()
				.withMessage('start_date must be an integer')

			req.checkBody('end_date')
				.optional({ checkFalsy: SkipValidation })
				.notEmpty()
				.withMessage('end_date field is empty')
				.isInt()
				.withMessage('end_date must be an integer')

			req.checkBody('type').optional().isString().withMessage('type must be a string')

			req.checkBody('status')
				.optional()
				.isIn([common.DRAFT_STATUS, common.PUBLISHED_STATUS])
				.withMessage('status must be one of DRAFT, PUBLISHED')
		}
	},
	details: (req) => {
		req.checkParams('id').notEmpty().withMessage('id param is empty')
	},

	enroll: (req) => {
		req.checkParams('id').notEmpty().withMessage('id param is empty')
	},

	unEnroll: (req) => {
		req.checkParams('id').notEmpty().withMessage('id param is empty')
	},

	share: (req) => {
		req.checkParams('id').notEmpty().withMessage('id param is empty')
	},

	updateRecordingUrl: (req) => {
		req.checkParams('id')
			.notEmpty()
			.withMessage('id param is empty')
			.isNumeric()
			.withMessage('id param is invalid, must be an integer')

		req.checkBody('recordingUrl').notEmpty().withMessage('recordingUrl field is empty')
	},
	enrolledMentees: (req) => {
		req.checkParams('id')
			.notEmpty()
			.withMessage('id param is empty')
			.isNumeric()
			.withMessage('id param is invalid, must be an integer')

		req.checkQuery('csv').optional().isBoolean().withMessage('csv is invalid, must be a boolean value')
	},

	addMentees: (req) => {
		// throw error if sessionId is not passed
		req.checkParams('id').notEmpty().withMessage('id param is empty')
		// Check if req.body.menteeIds is an array and not empty
		req.checkBody('mentees')
			.notEmpty()
			.withMessage('mentees field is empty')
			.isArray({ min: 1 })
			.withMessage('mentees must be an array')
	},

	removeMentees: (req) => {
		// throw error if sessionId is not passed
		req.checkParams('id').notEmpty().withMessage('id param is empty')
		// Check if req.body.menteeIds is an array and not empty
		req.checkBody('mentees')
			.notEmpty()
			.withMessage('mentees field is empty')
			.isArray({ min: 1 })
			.withMessage('mentees must be an array')
	},

	bulkUpdateMentorNames: (req) => {
		req.checkBody('mentor_id')
			.notEmpty()
			.withMessage('mentor_id field is empty')
			.isInt()
			.withMessage('mentor_id must be an integer')

		req.checkBody('mentor_name')
			.notEmpty()
			.withMessage('mentor_name field is empty')
			.isString()
			.withMessage('mentor_name must be a string')
	},

	bulkSessionCreate: (req) => {
		req.checkBody('file_path').notEmpty().withMessage('file_path field is empty')
	},
}
