module.exports = (sequelize, DataTypes) => {
	const Session = sequelize.define(
		'Session',
		{
			id: {
				type: DataTypes.INTEGER,
				allowNull: false,
				primaryKey: true,
				autoIncrement: true,
			},
			title: {
				type: DataTypes.STRING,
				allowNull: false,
			},
			description: {
				type: DataTypes.TEXT,
				allowNull: true,
			},
			recommended_for: {
				type: DataTypes.ARRAY(DataTypes.STRING),
				allowNull: true,
			},
			categories: {
				type: DataTypes.ARRAY(DataTypes.STRING),
				allowNull: true,
			},
			medium: {
				type: DataTypes.ARRAY(DataTypes.STRING),
				allowNull: true,
			},
			image: {
				type: DataTypes.ARRAY(DataTypes.STRING),
				allowNull: false,
				defaultValue: [],
			},
			mentor_id: {
				type: DataTypes.STRING,
				allowNull: true,
			},
			session_reschedule: {
				type: DataTypes.INTEGER,
				allowNull: false,
				defaultValue: 0,
			},
			status: {
				type: DataTypes.STRING,
				allowNull: false,
				defaultValue: 'PUBLISHED',
			},
			time_zone: {
				type: DataTypes.STRING,
				allowNull: false,
			},
			start_date: {
				type: DataTypes.BIGINT,
				allowNull: true,
			},
			end_date: {
				type: DataTypes.BIGINT,
				allowNull: true,
			},
			mentee_password: {
				type: DataTypes.STRING,
				allowNull: true,
			},
			mentor_password: {
				type: DataTypes.STRING,
				allowNull: true,
			},
			started_at: {
				type: DataTypes.DATE,
				allowNull: true,
			},
			share_link: {
				type: DataTypes.STRING,
				allowNull: true,
			},
			completed_at: {
				type: DataTypes.DATE,
				allowNull: true,
			},
			is_feedback_skipped: {
				type: DataTypes.BOOLEAN,
				allowNull: false,
				defaultValue: false,
			},
			mentee_feedback_question_set: {
				type: DataTypes.STRING,
				allowNull: true,
				defaultValue: 'MENTEE_QS1',
			},
			mentor_feedback_question_set: {
				type: DataTypes.STRING,
				allowNull: true,
				defaultValue: 'MENTOR_QS2',
			},
			meeting_info: {
				type: DataTypes.JSONB,
				allowNull: true,
			},
			meta: {
				type: DataTypes.JSONB,
				allowNull: true,
			},
			visibility: {
				type: DataTypes.STRING,
				allowNull: true,
			},
			visible_to_organizations: {
				type: DataTypes.ARRAY(DataTypes.STRING),
				allowNull: true,
			},
			mentor_organization_id: {
				type: DataTypes.STRING,
				allowNull: false,
			},
			seats_remaining: {
				type: DataTypes.INTEGER,
				defaultValue: process.env.SESSION_MENTEE_LIMIT,
			},
			seats_limit: {
				type: DataTypes.INTEGER,
				defaultValue: process.env.SESSION_MENTEE_LIMIT,
			},
			custom_entity_text: {
				type: DataTypes.JSON,
			},
			type: {
				type: DataTypes.STRING,
				allowNull: true,
				defaultValue: 'PUBLIC',
			},
			mentor_name: {
				type: DataTypes.STRING,
				allowNull: true,
			},
			created_by: {
				type: DataTypes.STRING,
				allowNull: true,
			},
			updated_by: {
				type: DataTypes.STRING,
				allowNull: true,
			},
			tenant_code: {
				type: DataTypes.STRING,
				allowNull: false,
			},
		},
		{ sequelize, modelName: 'Session', tableName: 'sessions', freezeTableName: true, paranoid: true }
	)

	Session.associate = (models) => {
		// Session has many attendees
		Session.hasMany(models.SessionAttendee, {
			foreignKey: 'session_id',
			as: 'attendees',
			scope: {
				deleted_at: null,
			},
		})

		// Session has many feedbacks
		Session.hasMany(models.Feedback, {
			foreignKey: 'session_id',
			as: 'feedbacks',
			scope: {
				deleted_at: null,
			},
		})

		// Session has many resources
		Session.hasMany(models.Resources, {
			foreignKey: 'session_id',
			as: 'resources',
			scope: {
				deleted_at: null,
			},
		})

		// Session has one post session detail
		Session.hasOne(models.PostSessionDetail, {
			foreignKey: 'session_id',
			as: 'post_session_detail',
			scope: {
				deleted_at: null,
			},
		})

		// Session has many availabilities (optional relationship)
		Session.hasMany(models.Availability, {
			foreignKey: 'session_id',
			as: 'availabilities',
			scope: {
				deleted_at: null,
			},
		})
	}

	return Session
}
