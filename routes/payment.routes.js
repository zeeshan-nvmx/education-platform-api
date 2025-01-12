const express = require('express')
const { protect } = require('../middleware/auth')
const validateMongoId = require('../middleware/validateMongoId')

const { initiateCoursePayment, initiateModulePayment, verifyPayment, getPaymentHistory, requestRefund, verifyCoupon } = require('../controllers/payment.controller')

const router = express.Router()

// Protect all payment routes
router.use(protect)

// Payment initiation routes
router.post('/course/:courseId', validateMongoId, initiateCoursePayment)
router.post('/module/:courseId/:moduleId', validateMongoId, initiateModulePayment)

// Payment verification and status
router.post('/verify', verifyPayment)
router.get('/history', getPaymentHistory)

// Refund routes
router.post('/refund/:paymentId', validateMongoId, requestRefund)

// Coupon verification
router.post('/verify-coupon', verifyCoupon)

module.exports = router
