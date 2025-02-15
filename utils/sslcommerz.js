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
    const { verify_sign, verify_key } = ipnData

    if (!verify_key) {
      console.error('Verify key missing in IPN data')
      return false
    }

    // Get ordered fields from verify_key
    const orderedFields = verify_key.split(',')

    // Create verification string with exact SSLCommerz format
    let verificationString = ''
    for (let i = 0; i < orderedFields.length; i++) {
      const field = orderedFields[i]
      const value = ipnData[field] === undefined ? '' : ipnData[field]

      if (i === 0) {
        verificationString += `${field}=${value}`
      } else {
        verificationString += `&${field}=${value}`
      }
    }

    // Add store password
    const finalString = `${verificationString}&store_passwd=${store_passwd}`

    // Log the final string for debugging
    console.log('Verification string:', verificationString)
    console.log('Final string with password:', finalString)

    // Generate both MD5 and SHA2 hashes
    const calculatedMD5Hash = crypto.createHash('md5').update(finalString).digest('hex')
    const calculatedSHA2Hash = crypto.createHash('sha256').update(finalString).digest('hex')

    // Check both hashes
    const isValidMD5 = calculatedMD5Hash.toLowerCase() === verify_sign.toLowerCase()
    const isValidSHA2 = calculatedSHA2Hash.toLowerCase() === ipnData.verify_sign_sha2?.toLowerCase()

    if (!isValidMD5 && !isValidSHA2) {
      console.error('IPN signature verification failed')
      console.error('Calculated MD5:', calculatedMD5Hash)
      console.error('Received MD5:', verify_sign)
      console.error('Calculated SHA2:', calculatedSHA2Hash)
      console.error('Received SHA2:', ipnData.verify_sign_sha2)
      return false
    }

    // Accept if either hash matches
    const isValidSignature = isValidMD5 || isValidSHA2

    // For additional security, validate through SSLCommerz API if val_id is present
    if (ipnData.val_id) {
      try {
        const validationResponse = await sslcommerz.validate({ val_id: ipnData.val_id })
        return validationResponse?.status === 'VALID'
      } catch (validationError) {
        console.error('SSLCommerz validation API error:', validationError)
        // If API validation fails, still accept if signature is valid
        return isValidSignature
      }
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
