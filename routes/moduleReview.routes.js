const express = require('express')
const { protect, restrictTo, optionalAuth } = require('../middleware/auth')
const validateMongoId = require('../middleware/validateMongoId')

const { createModuleReview, getModuleReview, deleteModuleReview, getAllModuleReviews, getPublicModuleReviews } = require('../controllers/moduleReview.controller')

const router = express.Router({ mergeParams: true }) // To access courseId and moduleId from parent routes

// Public routes with optional authentication
router.get('/:moduleId/reviews', optionalAuth, validateMongoId, getPublicModuleReviews)

// Protected routes - require authentication
router.post('/:moduleId/reviews', protect, validateMongoId, createModuleReview)
router.get('/:moduleId/reviews/my', protect, validateMongoId, getModuleReview)
router.delete('/:moduleId/reviews/my', protect, validateMongoId, deleteModuleReview)

// Admin routes
router.get('/:moduleId/reviews/admin', protect, restrictTo('admin', 'subAdmin', 'moderator'), validateMongoId, getAllModuleReviews)

module.exports = router
