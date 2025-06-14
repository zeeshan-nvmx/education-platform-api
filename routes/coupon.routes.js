const express = require('express')
const { protect, restrictTo } = require('../middleware/auth')
const validateMongoId = require('../middleware/validateMongoId')
const { createCoupon, getAllCoupons, getCoupon, updateCoupon, deleteCoupon, validateCoupon, getCouponStats } = require('../controllers/coupon.controller')

const router = express.Router()

// Public route for users to validate coupons
router.post('/validate', protect, validateCoupon)

// Admin routes
router.use(protect, restrictTo('admin', 'subAdmin'))

// Coupon management
router.get('/stats', getCouponStats)
router.get('/', getAllCoupons)
router.post('/', createCoupon)
router.get('/:couponId', validateMongoId, getCoupon)
router.patch('/:couponId', validateMongoId, updateCoupon)
router.delete('/:couponId', validateMongoId, deleteCoupon)

module.exports = router
