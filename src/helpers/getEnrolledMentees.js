const sessionAttendeesQueries = require('@database/queries/sessionAttendees')
const menteeExtensionQueries = require('@database/queries/userExtension')
const userRequests = require('@requests/user')
const entityTypeService = require('@services/entity-type')
const { Parser } = require('@json2csv/plainjs')

exports.getEnrolledMentees = async (sessionId, queryParams, tenantCode, enrolledBy = null) => {
	try {
		const filter = { session_id: sessionId }
		// Restrict to mentees enrolled by a specific user (enrolled_by_me column)
		if (enrolledBy) {
			filter.enrolled_by_me = String(enrolledBy)
		}
		const mentees = await sessionAttendeesQueries.findAll(filter, tenantCode)

		// Early return if no mentees found
		if (!mentees || mentees.length === 0) {
			return queryParams?.csv === 'true'
				? new Parser({
						fields: [
							{ label: 'No.', value: 'index_number' },
							{ label: 'Name', value: 'name' },
							{ label: 'Designation', value: 'designation' },
							{ label: 'Organization', value: 'organization' },
							{ label: 'E-mail ID', value: 'email' },
							{ label: 'Enrollment Type', value: 'type' },
						],
						header: true,
						includeEmptyRows: true,
						defaultValue: null,
				  }).parse()
				: []
		}

		let menteeTypeMap = {}
		const menteeIds = []
		mentees.forEach((mentee) => {
			menteeIds.push(mentee.mentee_id)
			const isDeleted = Boolean(mentee.deleted_at ?? mentee.deletedAt)
			menteeTypeMap[mentee.mentee_id] = isDeleted ? '' : mentee.type
		})

		// Fetch missing user details from DB if any
		let userDetailsResult = await userRequests.getUserDetailedListUsingCache(menteeIds, tenantCode, true, true)
		let enrolledUsers = userDetailsResult?.result || []

		enrolledUsers.forEach((user) => {
			if (menteeTypeMap.hasOwnProperty(user.user_id)) {
				user.type = menteeTypeMap[user.user_id]
			}
		})

		const CSVFields = [
			{ label: 'No.', value: 'index_number' },
			{ label: 'Name', value: 'name' },
			{ label: 'Designation', value: 'designation' },
			{ label: 'Organization', value: 'organization' },
			{ label: 'E-mail ID', value: 'email' },
			{ label: 'Enrollment Type', value: 'type' },
		]
		const parser = new Parser({
			fields: CSVFields,
			header: true,
			includeEmptyRows: true,
			defaultValue: null,
		})
		//Return an empty CSV/response if list is empty
		if (enrolledUsers.length === 0) {
			return queryParams?.csv === 'true'
				? new Parser({ fields: CSVFields, header: true, includeEmptyRows: true, defaultValue: null }).parse()
				: []
		}

		// Process entity types to add value labels
		const uniqueOrgCodes = [...new Set(enrolledUsers.map((user) => user.organization_code).filter(Boolean))]
		const modelName = await menteeExtensionQueries.getModelName()

		const processedUsers = await entityTypeService.processEntityTypesToAddValueLabels(
			enrolledUsers,
			uniqueOrgCodes,
			[modelName],
			'organization_code',
			[],
			tenantCode
		)

		// Check if processing actually returned processed data or error
		if (processedUsers && !processedUsers.responseCode) {
			enrolledUsers = processedUsers
		}

		if (queryParams?.csv === 'true') {
			const csv = parser.parse(
				enrolledUsers.map((user, index) => ({
					index_number: index + 1,
					name: user.name,
					designation: user.designation
						? user.designation.map((designation) => designation.label).join(', ')
						: '',
					email: user.email,
					type: user.type,
					organization: user.organization?.name || '',
				}))
			)

			return csv
		}

		const propertiesToDelete = [
			'user_id',
			'organization_id',
			'meta',
			'email_verified',
			'gender',
			'location',
			'about',
			'share_link',
			'status',
			'last_logged_in_at',
			'has_accepted_terms_and_conditions',
			'languages',
			'preferred_language',
			'custom_entity_text',
			'createdAt',
			'updatedAt',
			'deletedAt',
			'deleted_at',
		]

		const cleanedAttendeesAccounts = enrolledUsers.map((user, index) => {
			user.id = user.user_id
			propertiesToDelete.forEach((property) => {
				delete user[property]
			})
			user.index_number = index + 1
			return user
		})
		// Return success response with merged user details
		return cleanedAttendeesAccounts
	} catch (error) {
		throw error
	}
}
