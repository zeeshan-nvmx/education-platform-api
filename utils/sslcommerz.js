// utils/sslcommerz.js

const SSLCommerzPayment = require('sslcommerz-lts')
const store_id = process.env.SSLCOMMERZ_STORE_ID
const store_passwd = process.env.SSLCOMMERZ_STORE_PASSWORD
const is_live = process.env.SSLCOMMERZ_IS_LIVE === 'true'

const sslcommerz = new SSLCommerzPayment(store_id, store_passwd, is_live)

// Initialize payment with SSLCommerz
exports.initiatePayment = async (data) => {
  try {
    const response = await sslcommerz.init(data)

    if (!response?.GatewayPageURL) {
      throw new Error('Failed to get payment URL from SSLCommerz')
    }

    return response
  } catch (error) {
    console.error('SSLCommerz payment initiation error:', error)
    throw error
  }
}

// Validate payment with SSLCommerz
exports.validatePayment = async ({ val_id }) => {
  try {
    const response = await sslcommerz.validate({ val_id })
    return response
  } catch (error) {
    console.error('SSLCommerz payment validation error:', error)
    throw error
  }
}

// Initiate refund with SSLCommerz
exports.initiateRefund = async ({ refund_amount, trans_id, reason }) => {
  try {
    const response = await sslcommerz.initiateRefund({
      refund_amount,
      trans_id,
      reason,
    })
    return response
  } catch (error) {
    console.error('SSLCommerz refund initiation error:', error)
    throw error
  }
}

// Check refund status with SSLCommerz
exports.checkRefundStatus = async ({ refund_ref_id }) => {
  try {
    const response = await sslcommerz.refundQuery({
      refund_ref_id,
    })
    return response
  } catch (error) {
    console.error('SSLCommerz refund status check error:', error)
    throw error
  }
}

// Transaction Query by Transaction ID
exports.queryTransaction = async ({ trans_id }) => {
  try {
    const response = await sslcommerz.transactionQueryByTransactionId({
      trans_id,
    })
    return response
  } catch (error) {
    console.error('SSLCommerz transaction query error:', error)
    throw error
  }
}

// Transaction Query by Session ID
exports.queryTransactionBySession = async ({ sessionkey }) => {
  try {
    const response = await sslcommerz.transactionQueryBySessionId({
      sessionkey,
    })
    return response
  } catch (error) {
    console.error('SSLCommerz session query error:', error)
    throw error
  }
}

// const SSLCommerzPayment = require('sslcommerz-lts')

// const sslcommerzConfig = {
//   store_id: process.env.SSLCOMMERZ_STORE_ID,
//   store_passwd: process.env.SSLCOMMERZ_STORE_PASSWORD,
//   is_live: process.env.NODE_ENV === 'production',
// }

// exports.initiatePayment = async (data) => {
//   const sslcommerz = new SSLCommerzPayment(sslcommerzConfig)
//   const response = await sslcommerz.init_transaction(data)
//   return response
// }

// exports.validatePayment = async (data) => {
//   const sslcommerz = new SSLCommerzPayment(sslcommerzConfig)
//   const response = await sslcommerz.validate_transaction(data)
//   return response
// }
