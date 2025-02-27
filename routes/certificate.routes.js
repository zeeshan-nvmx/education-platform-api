const express = require('express')
const { protect, restrictTo } = require('../middleware/auth')
const validateMongoId = require('../middleware/validateMongoId')

const { getCourseCertificate, getModuleCertificate, getMockCourseCertificate, getMockModuleCertificate } = require('../controllers/certificate.controller')

const router = express.Router()

// Real certificate routes - verify completion before providing certificate
router.get('/:courseId/certificate', protect, validateMongoId, getCourseCertificate)
router.get('/:courseId/modules/:moduleId/certificate', protect, validateMongoId, getModuleCertificate)

// Mock certificate routes - provide certificate data without verifying completion
router.get('/:courseId/mock-certificate', protect, validateMongoId, getMockCourseCertificate)
router.get('/:courseId/modules/:moduleId/mock-certificate', protect, validateMongoId, getMockModuleCertificate)

module.exports = router
