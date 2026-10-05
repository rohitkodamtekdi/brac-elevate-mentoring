'use strict'

/** @type {import('sequelize-cli').Migration} */
module.exports = {
	up: async (queryInterface, Sequelize) => {
		const table = await queryInterface.describeTable('session_attendees')

		// User who enrolled the mentee (e.g. the Linkage Champion who assigned them, or the mentee on self enrollment)
		if (!table.enrolled_by) {
			await queryInterface.addColumn('session_attendees', 'enrolled_by', {
				type: Sequelize.STRING,
				allowNull: true,
			})
		}
	},

	down: async (queryInterface) => {
		const table = await queryInterface.describeTable('session_attendees')

		if (table.enrolled_by) {
			await queryInterface.removeColumn('session_attendees', 'enrolled_by')
		}
	},
}
