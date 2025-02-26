const express = require('express')
const { protect, restrictTo } = require('../middleware/auth')
const validateMongoId = require('../middleware/validateMongoId')

const { createQuiz, getQuiz, updateQuiz, deleteQuiz, startQuiz, submitQuiz, gradeQuiz, getQuizResults, resetUserAttempts } = require('../controllers/quiz.controller')

// mergeParams allows access to params from parent router
const router = express.Router({ mergeParams: true })

// Quiz creation and management (Admin/SubAdmin only)
router.post('/', protect, restrictTo('admin', 'subAdmin'), validateMongoId, createQuiz)

// Update quiz (Admin/SubAdmin only)
router.put('/', protect, restrictTo('admin', 'subAdmin'), validateMongoId, updateQuiz)

// Delete quiz (Admin/SubAdmin only)
router.delete('/', protect, restrictTo('admin', 'subAdmin'), validateMongoId, deleteQuiz)

// Reset user's quiz attempts (Admin/SubAdmin only)
router.post('/reset-attempts', protect, restrictTo('admin', 'subAdmin'), validateMongoId, resetUserAttempts)

// Get quiz details
router.get('/', protect, validateMongoId, getQuiz)

// Start a new quiz attempt
router.post('/attempts', protect, validateMongoId, startQuiz)

// Submit quiz attempt
router.post('/attempts/:attemptId/submit', protect, validateMongoId, submitQuiz)

// Grade text answers (Admin/Moderator/SubAdmin only)
router.post('/attempts/:attemptId/grade', protect, restrictTo('admin', 'moderator', 'subAdmin'), validateMongoId, gradeQuiz)

// Get quiz results
router.get('/attempts/:attemptId', protect, validateMongoId, getQuizResults)

module.exports = router
