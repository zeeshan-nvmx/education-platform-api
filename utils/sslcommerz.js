// utils/sslcommerz.js

const SSLCommerzPayment = require('sslcommerz-lts')
const crypto = require('crypto')

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

// Validate IPN signature and data
exports.validateIPN = async (ipnData) => {
  try {
    const { verify_sign, verify_key, ...dataToVerify } = ipnData

    // Sort the data alphabetically by key
    const sortedData = Object.keys(dataToVerify)
      .sort()
      .reduce((obj, key) => {
        obj[key] = dataToVerify[key]
        return obj
      }, {})

    // Create the verification string
    const verificationString = Object.entries(sortedData)
      .map(([key, value]) => `${key}=${value}`)
      .join('&')

    // Add store password
    const finalString = `${verificationString}&store_passwd=${store_passwd}`

    // Generate MD5 hash
    const calculatedHash = crypto.createHash('md5').update(finalString).digest('hex')

    // Verify the signature
    const isValidSignature = calculatedHash.toLowerCase() === verify_sign.toLowerCase()

    if (!isValidSignature) {
      console.error('IPN signature verification failed')
      return false
    }

    // Additional validation through SSLCommerz API
    if (ipnData.val_id) {
      const validationResponse = await sslcommerz.validate({ val_id: ipnData.val_id })
      return validationResponse?.status === 'VALID'
    }

    return isValidSignature
  } catch (error) {
    console.error('SSLCommerz IPN validation error:', error)
    return false
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
