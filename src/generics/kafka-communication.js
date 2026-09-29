/**
 * name : generics/kafka-communication
 * author : Aman Gupta
 * Date : 08-Nov-2021
 * Description : Kafka producer methods
 */

const emailEncryption = require('@utils/emailEncryption')

const pushEmailToKafka = async (message) => {
	try {
		if (message.email && message.email.to) {
			const decryptData = await emailEncryption.decryptAndValidate(message.email.to)
			if (decryptData) {
				message.email.to = decryptData
			}
		}
		const payload = { topic: process.env.NOTIFICATION_KAFKA_TOPIC, messages: [{ value: JSON.stringify(message) }] }
		console.log('KAKFA PAYLOAD: ', payload)
		return await pushPayloadToKafka(payload)
	} catch (error) {
		console.log(error)
		throw error
	}
}

const clearInternalCache = async (key) => {
	try {
		const payload = {
			topic: process.env.CLEAR_INTERNAL_CACHE,
			messages: [{ value: JSON.stringify({ value: key, type: 'CLEAR_INTERNAL_CACHE' }) }],
		}

		return await pushPayloadToKafka(payload)
	} catch (error) {
		throw error
	}
}

const pushSessionEnrollmentToKafka = async (data) => {
	try {
		const topic = process.env.SESSION_ENROLLMENT_TOPIC || 'session-enrollment-topic'
		const payload = {
			topic,
			messages: [{ value: JSON.stringify(data) }],
		}
		console.log('Pushing session enrollment event to kafka:', payload)
		return await pushPayloadToKafka(payload)
	} catch (error) {
		console.error('Error pushing session enrollment to Kafka:', error)
	}
}

const pushPayloadToKafka = async (payload) => {
	try {
		console.log('sending kafka message from service ', payload)
		let response = await kafkaProducer.send(payload)
		console.log('kafka response for   ', response)
		return response
	} catch (error) {
		return error
	}
}

module.exports = {
	pushEmailToKafka,
	clearInternalCache,
	pushSessionEnrollmentToKafka,
}
