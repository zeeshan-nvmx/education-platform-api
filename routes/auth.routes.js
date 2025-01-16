const express = require('express')
const { loginLimiter } = require('../middleware/rateLimiter')
const { protect } = require('../middleware/auth')
const { signup, verifyEmail, login, forgotPassword, resetPassword, changePassword } = require('../controllers/auth.controller')

const router = express.Router()

router.post('/signup', signup)
router.post('/verify-email', verifyEmail)
router.post('/login', login)
router.post('/forgot-password', forgotPassword)
router.post('/reset-password', resetPassword)
router.post('/change-password', protect, changePassword)

module.exports = router
