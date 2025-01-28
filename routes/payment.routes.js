const express = require('express')
const { protect } = require('../middleware/auth')
const validateMongoId = require('../middleware/validateMongoId')

const { initiateCoursePayment, initiateModulePayment, verifyPayment, getPaymentHistory, requestRefund, verifyCoupon } = require('../controllers/payment.controller')

const router = express.Router()

// Payment initiation routes
router.post('/course/:courseId', protect, validateMongoId, initiateCoursePayment)

router.post('/module/:courseId/:moduleId', protect, validateMongoId, initiateModulePayment)

// Payment verification and status
router.post('/verify', protect, verifyPayment)

router.get('/history', protect, getPaymentHistory)

// Refund routes
router.post('/refund/:paymentId', protect, validateMongoId, requestRefund)

// Coupon verification
router.post('/verify-coupon', protect, verifyCoupon)

module.exports = router

// const express = require('express')
// const { protect } = require('../middleware/auth')
// const validateMongoId = require('../middleware/validateMongoId')

// const { initiateCoursePayment, initiateModulePayment, verifyPayment, getPaymentHistory, requestRefund, verifyCoupon } = require('../controllers/payment.controller')

// const router = express.Router()

// // Protect all payment routes
// router.use(protect)

// // Payment initiation routes
// router.post('/course/:courseId', validateMongoId, initiateCoursePayment)
// router.post('/module/:courseId/:moduleId', validateMongoId, initiateModulePayment)

// // Payment verification and status
// router.post('/verify', verifyPayment)
// router.get('/history', getPaymentHistory)

// // Refund routes
// router.post('/refund/:paymentId', validateMongoId, requestRefund)

// // Coupon verification
// router.post('/verify-coupon', verifyCoupon)

// module.exports = router
