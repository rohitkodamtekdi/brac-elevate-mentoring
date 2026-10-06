'use strict'

/** @type {import('sequelize-cli').Migration} */
module.exports = {
	// Draft sessions can be saved without description or dates; publishing still requires them
	up: async (queryInterface) => {
		await queryInterface.sequelize.query(`
			ALTER TABLE sessions
				ALTER COLUMN description DROP NOT NULL,
				ALTER COLUMN start_date DROP NOT NULL,
				ALTER COLUMN end_date DROP NOT NULL;
		`)
	},

	down: async (queryInterface) => {
		await queryInterface.sequelize.query(`
			ALTER TABLE sessions
				ALTER COLUMN description SET NOT NULL,
				ALTER COLUMN start_date SET NOT NULL,
				ALTER COLUMN end_date SET NOT NULL;
		`)
	},
}
