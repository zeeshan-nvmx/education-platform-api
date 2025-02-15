// utils/sslcommerz.js
const SSLCommerzPayment = require('sslcommerz-lts')
const crypto = require('crypto')

const store_id = process.env.SSLCOMMERZ_STORE_ID
const store_passwd = process.env.SSLCOMMERZ_STORE_PASSWORD
const is_live = process.env.SSLCOMMERZ_IS_LIVE === 'true'

const sslcommerz = new SSLCommerzPayment(store_id, store_passwd, is_live)

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

exports.validateIPN = async (ipnData) => {
  try {
    console.log('Validating IPN with data:', JSON.stringify(ipnData, null, 2))

    const { verify_sign, verify_key } = ipnData

    if (!verify_key) {
      console.error('Verify key missing in IPN data')
      return false
    }

    // Create a normalized copy of the data
    const normalizedData = { ...ipnData }
    delete normalizedData.verify_sign
    delete normalizedData.verify_key
    delete normalizedData.verify_sign_sha2

    // Build verification string using all received fields
    const verificationString = verify_key
      .split(',')
      .map((field) => `${field}=${normalizedData[field] || ''}`)
      .join('&')

    // Add store password
    const finalString = `${verificationString}&store_passwd=${store_passwd}`

    // Log verification details for debugging
    console.log('Final verification string:', finalString)

    // Calculate MD5 hash
    const calculatedHash = crypto.createHash('md5').update(finalString).digest('hex')

    // Log hash comparison
    console.log('Calculated hash:', calculatedHash)
    console.log('Received hash:', verify_sign)

    // Compare hashes
    const isValid = calculatedHash.toLowerCase() === verify_sign.toLowerCase()

    if (!isValid) {
      console.error('Hash verification failed')
      return false
    }

    // If validation succeeded and val_id is present, verify with SSLCommerz API
    if (isValid && ipnData.val_id) {
      try {
        const validationResponse = await sslcommerz.validate({ val_id: ipnData.val_id })
        if (validationResponse?.status !== 'VALID') {
          console.error('SSLCommerz API validation failed:', validationResponse)
          return false
        }
      } catch (validationError) {
        console.error('SSLCommerz API validation error:', validationError)
        // Continue with local validation result if API check fails
      }
    }

    return isValid
  } catch (error) {
    console.error('IPN validation error:', error)
    return false
  }
}

// Additional SSLCommerz utility functions
exports.validatePayment = async ({ val_id }) => {
  try {
    const response = await sslcommerz.validate({ val_id })
    return response
  } catch (error) {
    console.error('SSLCommerz payment validation error:', error)
    throw error
  }
}

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
// const store_id = process.env.SSLCOMMERZ_STORE_ID
// const store_passwd = process.env.SSLCOMMERZ_STORE_PASSWORD
// const is_live = process.env.SSLCOMMERZ_IS_LIVE === 'true'

// const sslcommerz = new SSLCommerzPayment(store_id, store_passwd, is_live)

// // Initialize payment with SSLCommerz
// exports.initiatePayment = async (data) => {
//   try {
//     const response = await sslcommerz.init(data)

//     if (!response?.GatewayPageURL) {
//       throw new Error('Failed to get payment URL from SSLCommerz')
//     }

//     return response
//   } catch (error) {
//     console.error('SSLCommerz payment initiation error:', error)
//     throw error
//   }
// }

// // Validate payment with SSLCommerz
// exports.validatePayment = async ({ val_id }) => {
//   try {
//     const response = await sslcommerz.validate({ val_id })
//     return response
//   } catch (error) {
//     console.error('SSLCommerz payment validation error:', error)
//     throw error
//   }
// }

// // Initiate refund with SSLCommerz
// exports.initiateRefund = async ({ refund_amount, trans_id, reason }) => {
//   try {
//     const response = await sslcommerz.initiateRefund({
//       refund_amount,
//       trans_id,
//       reason,
//     })
//     return response
//   } catch (error) {
//     console.error('SSLCommerz refund initiation error:', error)
//     throw error
//   }
// }

// // Check refund status with SSLCommerz
// exports.checkRefundStatus = async ({ refund_ref_id }) => {
//   try {
//     const response = await sslcommerz.refundQuery({
//       refund_ref_id,
//     })
//     return response
//   } catch (error) {
//     console.error('SSLCommerz refund status check error:', error)
//     throw error
//   }
// }

// // Transaction Query by Transaction ID
// exports.queryTransaction = async ({ trans_id }) => {
//   try {
//     const response = await sslcommerz.transactionQueryByTransactionId({
//       trans_id,
//     })
//     return response
//   } catch (error) {
//     console.error('SSLCommerz transaction query error:', error)
//     throw error
//   }
// }

// // Transaction Query by Session ID
// exports.queryTransactionBySession = async ({ sessionkey }) => {
//   try {
//     const response = await sslcommerz.transactionQueryBySessionId({
//       sessionkey,
//     })
//     return response
//   } catch (error) {
//     console.error('SSLCommerz session query error:', error)
//     throw error
//   }
// }
