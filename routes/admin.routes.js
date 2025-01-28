// const express = require('express')
// const { protect, restrictTo } = require('../middleware/auth')
// const adminController = require('../controllers/admin.controller')

// const router = express.Router()

// // Protect all routes after this middleware
// router.use(protect)
// router.use(restrictTo('admin'))


// const { createUser, getUsers, deleteUser, updateUserRole } = adminController

// router.route('/users').post(createUser).get(getUsers)

// router.route('/users/:userId').delete(deleteUser).patch(updateUserRole) 

// module.exports = router

const express = require('express')
const { protect, restrictTo } = require('../middleware/auth')
const adminController = require('../controllers/admin.controller')

const router = express.Router()

const { createUser, getUsers, deleteUser, updateUserRole } = adminController

// User creation
router.post('/users', protect, restrictTo('admin', 'subAdmin'), createUser)

// Get all users
router.get('/users', protect, restrictTo('admin', 'subAdmin'), getUsers)

// Delete specific user
router.delete('/users/:userId', protect, restrictTo('admin', 'subAdmin'), deleteUser)

// Update user role
router.patch('/users/:userId', protect, restrictTo('admin', 'subAdmin'), updateUserRole)

module.exports = router