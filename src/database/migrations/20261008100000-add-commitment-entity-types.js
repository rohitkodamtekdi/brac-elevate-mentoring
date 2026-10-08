'use strict'

// Commitment numbers captured on the Support Provider's profile, used by the dashboard
// (committed = sessions_committed + services_committed). They are free numeric inputs
// (no entities), so their values are stored in user_extensions.meta.
const COMMITMENT_ENTITY_TYPES = {
	sessions_committed: { sequence: 1 },
	services_committed: { sequence: 2 },
	assets_committed: { sequence: 3 },
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
	up: async (queryInterface) => {
		const transaction = await queryInterface.sequelize.transaction()
		try {
			const defaultOrgCode = process.env.DEFAULT_ORGANISATION_CODE
			if (!defaultOrgCode) {
				throw new Error('DEFAULT_ORGANISATION_CODE env variable is not set')
			}

			// Entity types are tenant scoped, so add them under the default org of every active tenant
			const [defaultOrgPerTenants] = await queryInterface.sequelize.query(
				`SELECT DISTINCT oe.tenant_code, oe.organization_id, oe.organization_code
				FROM organization_extension oe
				WHERE oe.deleted_at IS NULL
					AND oe.organization_code = :defaultOrgCode`,
				{ transaction, replacements: { defaultOrgCode } }
			)

			const entityTypeRows = []
			for (const org of defaultOrgPerTenants) {
				for (const [value, { sequence }] of Object.entries(COMMITMENT_ENTITY_TYPES)) {
					entityTypeRows.push({
						value,
						label: convertToWords(value),
						data_type: 'INTEGER',
						status: 'ACTIVE',
						created_by: 0,
						updated_by: 0,
						allow_filtering: false,
						has_entities: false,
						allow_custom_entities: false,
						required: false,
						model_names: ['UserExtension'],
						organization_id: org.organization_id,
						organization_code: org.organization_code,
						tenant_code: org.tenant_code,
						meta: JSON.stringify({
							label: convertToWords(value),
							visible: true,
							visibility: 'main',
							sequence,
						}),
						created_at: new Date(),
						updated_at: new Date(),
					})
				}
			}

			if (entityTypeRows.length > 0) {
				await queryInterface.bulkInsert('entity_types', entityTypeRows, { transaction, ignoreDuplicates: true })
			}
			await transaction.commit()
		} catch (error) {
			await transaction.rollback()
			throw error
		}
	},

	down: async (queryInterface) => {
		await queryInterface.bulkDelete('entity_types', { value: Object.keys(COMMITMENT_ENTITY_TYPES) })
	},
}

function convertToWords(inputString) {
	return inputString
		.split('_')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ')
}
