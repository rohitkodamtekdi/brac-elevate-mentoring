const UserExtension = require('@database/models/index').UserExtension
const MentorExtension = UserExtension.scope('mentors')

const { QueryTypes } = require('sequelize')
const sequelize = require('sequelize')
const Sequelize = require('@database/models/index').sequelize
const common = require('@constants/common')
const utils = require('@generics/utils')
const _ = require('lodash')
const { Op } = require('sequelize')
const emailEncryption = require('@utils/emailEncryption')

module.exports = class MentorExtensionQueries {
	static async getColumns() {
		try {
			return await Object.keys(MentorExtension.rawAttributes)
		} catch (error) {
			throw error
		}
	}

	static async getModelName() {
		try {
			return await MentorExtension.name
		} catch (error) {
			throw error
		}
	}
	static async getTableName() {
		try {
			return await MentorExtension.tableName
		} catch (error) {
			throw error
		}
	}

	static async createMentorExtension(data, tenantCode) {
		try {
			data = { ...data, is_mentor: true, tenant_code: tenantCode }
			const [mentorExtension, created] = await MentorExtension.findOrCreate({
				where: {
					user_id: data.user_id,
					tenant_code: tenantCode,
				},
				defaults: data,
			})
			return mentorExtension
		} catch (error) {
			throw error
		}
	}

	static async updateMentorExtension(userId, data, options = {}, customFilter = {}, unscoped = false, tenantCode) {
		try {
			data = { ...data, is_mentor: true }

			if (data.user_id) {
				delete data['user_id']
			}
			if (data.tenant_code) {
				delete data['tenant_code']
			}

			let whereClause
			if (_.isEmpty(customFilter)) {
				whereClause = { user_id: userId, tenant_code: tenantCode }
			} else {
				whereClause = { ...customFilter, tenant_code: tenantCode } // Ensure tenant_code is always included
			}
			// If `meta` is included in `data`, use `jsonb_set` to merge changes safely
			if (data.meta) {
				let metaExpr = Sequelize.fn('COALESCE', Sequelize.col('meta'), Sequelize.literal(`'{}'::jsonb`))

				for (const [key, value] of Object.entries(data.meta)) {
					if (!/^[A-Za-z0-9_-]+$/.test(key)) {
						throw new Error(`Invalid meta key: ${key}`)
					}
					metaExpr = Sequelize.fn(
						'jsonb_set',
						metaExpr,
						Sequelize.literal(`'{${key}}'`),
						Sequelize.literal(`${Sequelize.escape(JSON.stringify(value))}::jsonb`),
						true
					)
				}

				data.meta = metaExpr
			} else {
				delete data.meta
			}

			// Safe merge: tenant filtering cannot be overridden by options.where
			const { where: optionsWhere, ...otherOptions } = options

			const result = unscoped
				? await MentorExtension.unscoped().update(data, {
						where: {
							...optionsWhere, // Allow additional where conditions
							...whereClause, // But tenant filtering takes priority
						},
						...otherOptions,
				  })
				: await MentorExtension.update(data, {
						where: {
							...optionsWhere, // Allow additional where conditions
							...whereClause, // But tenant filtering takes priority
						},
						...otherOptions,
				  })
			return result
		} catch (error) {
			throw error
		}
	}

	static async getMentorExtension(userId, attributes = [], unScoped = false, tenantCode) {
		try {
			const queryOptions = {
				where: {
					user_id: userId,
					tenant_code: tenantCode,
				},
				raw: true,
			}
			// If attributes are passed update query
			if (attributes.length > 0) {
				queryOptions.attributes = attributes
			}
			let mentor
			if (unScoped) {
				mentor = await MentorExtension.unscoped().findOne(queryOptions)
			} else {
				mentor = await MentorExtension.findOne(queryOptions)
			}
			if (mentor && mentor.email) {
				mentor.email = await emailEncryption.decrypt(mentor.email.toLowerCase())
			}
			return mentor
		} catch (error) {
			throw error
		}
	}

	static async deleteMentorExtension(userId, tenantCode, force = false) {
		try {
			const options = { where: { user_id: userId, tenant_code: tenantCode } }

			if (force) {
				options.force = true
			}

			return await MentorExtension.destroy(options)
		} catch (error) {
			throw error
		}
	}
	static async removeMentorDetails(userId, tenantCode) {
		try {
			const fieldsToClear = {
				designation: [],
				area_of_expertise: [],
				education_qualification: null,
				rating: {},
				meta: {},
				stats: {},
				tags: [],
				configs: {},
				visible_to_organizations: [],
				external_session_visibility: null,
				custom_entity_text: {},
				experience: null,
				external_mentee_visibility: null,
				mentee_visibility: null,
				external_mentor_visibility: null,
				mentor_visibility: null,
				name: common.USER_NOT_FOUND,
				email: null,
				phone: null,
				settings: {},
				image: null,
				gender: null,
				status: null,
				username: null,
				deleted_at: new Date(),
			}

			return await MentorExtension.update(fieldsToClear, {
				where: {
					user_id: userId,
					tenant_code: tenantCode,
				},
			})
		} catch (error) {
			throw error
		}
	}
	static async getMentorsByUserIds(ids, options = {}, tenantCode, unscoped = false) {
		try {
			// Safe merge: tenant filtering cannot be overridden by options.where
			const { where: optionsWhere, ...otherOptions } = options

			const query = {
				where: {
					...optionsWhere, // Allow additional where conditions
					user_id: ids,
					tenant_code: tenantCode, // Tenant filtering takes priority
				},
				...otherOptions,
				returning: true,
				raw: true,
			}

			const result = unscoped
				? await MentorExtension.unscoped().findAll(query)
				: await MentorExtension.findAll(query)

			return result
		} catch (error) {
			throw error
		}
	}

	static async getAllMentors(options = {}) {
		try {
			const result = await MentorExtension.findAll({
				...options,
				returning: true,
				raw: true,
			})

			return result
		} catch (error) {
			throw error
		}
	}

	static async getMentorsByUserIdsFromView(
		ids,
		page = null,
		limit = null,
		filter,
		saasFilter = '',
		additionalProjectionclause = '',
		returnOnlyUserId,
		searchFilter = '',
		searchText,
		defaultFilter = '',
		tenantCode
	) {
		try {
			const excludeUserIds = ids.length === 0
			let userFilterClause = excludeUserIds ? '' : `user_id IN (${ids.map((id) => `'${id}'`).join(',')})`
			let additionalFilter = ''
			if (searchText) {
				additionalFilter = `AND name ILIKE :search`
			}
			if (Array.isArray(searchText)) {
				additionalFilter = `AND email IN ('${searchText.join("','")}')`
			}
			if (searchFilter.whereClause && searchFilter.whereClause != '') {
				additionalFilter = `${searchFilter.whereClause}`
			}

			const filterClause = filter?.query.length > 0 ? `${filter.query}` : ''

			let saasFilterClause = saasFilter !== '' ? saasFilter : ''
			const defaultFilterClause = defaultFilter != '' ? 'AND ' + defaultFilter : ''
			console.log(
				'saasFilterClause',
				saasFilterClause,
				'filterClause',
				filterClause,
				'userFilterClause',
				userFilterClause,
				'additionalFilter',
				additionalFilter,
				'defaultFilterClause',
				defaultFilterClause
			)
			if (excludeUserIds && filter.query.length === 0 && saasFilterClause) {
				saasFilterClause = saasFilterClause.replace('AND ', '') // Remove "AND" if excludeUserIds is true and filter is empty
			}

			let projectionClause =
				'user_id,experience,image,name,email,designation,organization_code,area_of_expertise,education_qualification,custom_entity_text,rating,mentor_visibility,mentee_visibility,meta,tenant_code,status,settings,organization_id,phone,is_mentor'

			if (returnOnlyUserId) {
				projectionClause = 'user_id'
			} else if (additionalProjectionclause !== '') {
				projectionClause += `,${additionalProjectionclause}`
			}
			if (userFilterClause && filterClause.length > 0) {
				filterClause = filterClause.startsWith('AND') ? filterClause : 'AND ' + filterClause
			}

			const viewName = utils.getTenantViewName(tenantCode, MentorExtension.tableName)
			let query = `
				SELECT ${projectionClause}
				FROM
					${viewName}
				WHERE
					${userFilterClause}
					${filterClause}
					${saasFilterClause}
					${additionalFilter}
					${defaultFilterClause}
					AND is_mentor = true
			`

			const replacements = {
				...filter.replacements, // Add filter parameters to replacements
				search: `%${searchText}%`,
			}

			if (searchFilter && searchFilter?.sortQuery !== '') {
				query += `
				ORDER BY
					${searchFilter.sortQuery}`
			} else {
				query += `
				ORDER BY
					LOWER(name) ASC`
			}

			if (page !== null && limit !== null) {
				query += `
				OFFSET
					:offset
				LIMIT
					:limit;
				`
				replacements.offset = limit * (page - 1)
				replacements.limit = limit
			}

			const mentors = await Sequelize.query(query, {
				type: QueryTypes.SELECT,
				replacements: replacements,
			})

			const countQuery = `
			SELECT count(*) AS "count"
			FROM
				${viewName}
			WHERE
				${userFilterClause}
				${filterClause}
				${saasFilterClause}
				${additionalFilter}
				${defaultFilterClause}
				AND is_mentor = true
			;
		`
			const count = await Sequelize.query(countQuery, {
				type: QueryTypes.SELECT,
				replacements: replacements,
			})

			return {
				data: mentors,
				count: Number(count[0].count),
			}
		} catch (error) {
			throw error
		}
	}

	static async addVisibleToOrg(organizationId, newRelatedOrgs, options = {}) {
		await MentorExtension.update(
			{
				visible_to_organizations: sequelize.literal(
					`array_cat("visible_to_organizations", ARRAY[${newRelatedOrgs}]::integer[])`
				),
			},
			{
				where: {
					organization_id: organizationId,
					[Op.or]: [
						{
							[Op.not]: {
								visible_to_organizations: {
									[Op.contains]: newRelatedOrgs,
								},
							},
						},
						{
							visible_to_organizations: {
								[Op.is]: null,
							},
						},
					],
				},
				...options,
				individualHooks: true,
			}
		)
		return await MentorExtension.update(
			{
				visible_to_organizations: sequelize.literal(`COALESCE("visible_to_organizations", 
										 ARRAY[]::integer[]) || ARRAY[${organizationId}]::integer[]`),
			},
			{
				where: {
					organization_id: {
						[Op.in]: [...newRelatedOrgs],
					},
					[Op.or]: [
						{
							[Op.not]: {
								visible_to_organizations: {
									[Op.contains]: [organizationId],
								},
							},
						},
						{
							visible_to_organizations: {
								[Op.is]: null,
							},
						},
					],
				},
				individualHooks: true,
				...options,
			}
		)
	}

	static async removeVisibleToOrg(orgId, elementsToRemove) {
		const organizationUpdateQuery = `
		  UPDATE "mentor_extensions"
		  SET "visible_to_organizations" = (
			SELECT array_agg(elem)
			FROM unnest("visible_to_organizations") AS elem
			WHERE elem NOT IN (${elementsToRemove.join(',')})
		  )
		  WHERE organization_id = :orgId
		`

		await Sequelize.query(organizationUpdateQuery, {
			replacements: { orgId },
			type: Sequelize.QueryTypes.UPDATE,
		})
		const relatedOrganizationUpdateQuery = `
		  UPDATE "mentor_extensions"
		  SET "visible_to_organizations" = (
			SELECT array_agg(elem)
			FROM unnest("visible_to_organizations") AS elem
			WHERE elem NOT IN (${orgId})
		  )
		  WHERE organization_id IN (:elementsToRemove)
		`

		await Sequelize.query(relatedOrganizationUpdateQuery, {
			replacements: { elementsToRemove },
			type: Sequelize.QueryTypes.UPDATE,
		})
	}
	static async getMentorExtensions(userIds, attributes = [], tenantCode) {
		try {
			const queryOptions = { where: { user_id: { [Op.in]: userIds }, tenant_code: tenantCode }, raw: true }
			if (attributes.length > 0) {
				queryOptions.attributes = attributes
			}
			const mentors = await MentorExtension.findAll(queryOptions)
			return mentors
		} catch (error) {
			throw error
		}
	}
	static async getMentorsFromView(
		whereClause = '',
		projection = 'user_id,rating,meta,mentor_visibility,mentee_visibility,organization_id,designation,area_of_expertise,education_qualification,custom_entity_text',
		saasFilterClause = ''
	) {
		try {
			// Remove leading "AND" from saasFilterClause if necessary
			if (saasFilterClause.startsWith('AND')) {
				saasFilterClause = saasFilterClause.replace('AND', '')
			}

			// Ensure whereClause includes the is_mentor = true condition
			whereClause = `is_mentor = true${whereClause ? ` AND ${whereClause}` : ''}`

			// Construct the query with the provided whereClause, projection, and saasFilterClause
			let query = `
				SELECT ${projection}
				FROM ${utils.getTenantViewName(tenantCode, MentorExtension.tableName)}
				WHERE ${whereClause}
				${saasFilterClause}
			`

			// Execute the query
			const mentors = await Sequelize.query(query, {
				type: QueryTypes.SELECT,
			})

			// Count query
			const countQuery = `
				SELECT count(*) AS "count"
				FROM ${utils.getTenantViewName(tenantCode, MentorExtension.tableName)}
				WHERE ${whereClause}
				${saasFilterClause}
			`

			// Execute the count query
			const count = await Sequelize.query(countQuery, {
				type: QueryTypes.SELECT,
			})

			return {
				data: mentors,
				count: Number(count[0].count),
			}
		} catch (error) {
			throw error
		}
	}

	static async findOneFromView(userId, tenantCode) {
		try {
			let query = `
				SELECT *
				FROM ${utils.getTenantViewName(tenantCode, MentorExtension.tableName)}
				WHERE user_id = :userId
				LIMIT 1
			`

			const user = await Sequelize.query(query, {
				replacements: { userId },
				type: QueryTypes.SELECT,
			})

			return user.length > 0 ? user[0] : null
		} catch (error) {
			throw error
		}
	}
}
