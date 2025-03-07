const express = require('express')
const { protect, restrictTo } = require('../middleware/auth')
const adminController = require('../controllers/admin.controller')

const router = express.Router()

const { createUser, getUsers, deleteUser, updateUserRole } = adminController
const { getUngradedSubmissions, getQuizAttemptById } = require('../controllers/quiz.controller')

// Non conflicting submitted quiz grading route for admins and moderators
router.get('/quizzes/ungraded', protect, restrictTo('admin', 'subAdmin', 'moderator'), getUngradedSubmissions)

// Get a single quiz attempt
router.get('/quizzes/attempts/:attemptId', protect, restrictTo('admin', 'subAdmin', 'moderator'), getQuizAttemptById)

// User creation
router.post('/users', protect, restrictTo('admin', 'subAdmin'), createUser)

// Get all users
router.get('/users', protect, restrictTo('admin', 'subAdmin'), getUsers)

// Delete specific user
router.delete('/users/:userId', protect, restrictTo('admin', 'subAdmin'), deleteUser)

// Update user role
router.patch('/users/:userId', protect, restrictTo('admin', 'subAdmin'), updateUserRole)

module.exports = router