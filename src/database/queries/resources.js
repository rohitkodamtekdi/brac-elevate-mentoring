const Resources = require('../models/index').Resources
const Session = require('../models/index').Session

module.exports = class ResourcessData {
	static async bulkCreate(data, tenantCode) {
		try {
			// Assign tenant_code to all data entries
			const dataWithTenant = data.map((item) => ({
				...item,
				tenant_code: tenantCode,
			}))

			const resources = await Resources.bulkCreate(dataWithTenant, {
				returning: true, // to return the inserted records
			})
			return resources
		} catch (error) {
			return error
		}
	}

	static async create(data, tenantCode) {
		try {
			data.tenant_code = tenantCode
			const resources = await Resources.create(data, { returning: true })
			return resources
		} catch (error) {
			return error
		}
	}

	static async findOneResources(filter, tenantCode, projection = {}) {
		try {
			const whereClause = {
				...filter,
				tenant_code: tenantCode,
			}
			const ResourcesData = await Resources.findOne({
				where: whereClause,
				attributes: projection,
				raw: true,
			})
			return ResourcesData
		} catch (error) {
			return error
		}
	}

	static async deleteResource(sessionId, tenantCode, projection = {}) {
		try {
			const ResourcesData = await Resources.destroy({
				where: { session_id: sessionId, tenant_code: tenantCode },
				raw: true,
			})
			return ResourcesData
		} catch (error) {
			return error
		}
	}

	static async deleteResourceById(resourceId, sessionId, tenantCode) {
		try {
			const ResourcesData = await Resources.destroy({
				where: { id: resourceId, session_id: sessionId, tenant_code: tenantCode },
				raw: true,
			})
			return ResourcesData
		} catch (error) {
			return error
		}
	}

	static async deleteResourceByIdWithSessionValidation(resourceId, sessionId, tenantCode) {
		try {
			// Validate session belongs to tenant
			const sessionExists = await Session.count({
				where: { id: sessionId, tenant_code: tenantCode },
			})

			if (!sessionExists) return 0

			// Delete resource in same tenant+session scope
			const deletedCount = await Resources.destroy({
				where: {
					id: resourceId,
					session_id: sessionId,
					tenant_code: tenantCode,
				},
			})

			return deletedCount > 0 ? 1 : 0
		} catch (error) {
			return error
		}
	}

	// Same as find(), plus the linked session's title/description/categories (and meta - assets keep their
	// livelihood category in meta.livelihoods) so lists can show the resource's category and description
	static async findWithSession(filter, tenantCode) {
		try {
			return await Resources.findAll({
				where: {
					...filter,
					deleted_at: null,
					tenant_code: tenantCode,
				},
				include: [
					{
						model: Session,
						as: 'session',
						attributes: ['id', 'title', 'description', 'categories', 'meta'],
						required: false,
					},
				],
				raw: true,
				nest: true,
			})
		} catch (error) {
			return error
		}
	}

	static async find(filter, tenantCode, projection = {}) {
		try {
			const whereClause = {
				...filter,
				deleted_at: null,
				tenant_code: tenantCode,
			}
			const ResourcesData = await Resources.findAll({
				where: whereClause,
				attributes: projection,
				raw: true,
			})
			return ResourcesData
		} catch (error) {
			return error
		}
	}
}
