const SSLCommerzPayment = require('sslcommerz-nodejs')

const sslcommerzConfig = {
  store_id: process.env.SSLCOMMERZ_STORE_ID,
  store_passwd: process.env.SSLCOMMERZ_STORE_PASSWORD,
  is_live: process.env.NODE_ENV === 'production',
}

exports.initiatePayment = async (data) => {
  const sslcommerz = new SSLCommerzPayment(sslcommerzConfig)
  const response = await sslcommerz.init_transaction(data)
  return response
}

exports.validatePayment = async (data) => {
  const sslcommerz = new SSLCommerzPayment(sslcommerzConfig)
  const response = await sslcommerz.validate_transaction(data)
  return response
}
