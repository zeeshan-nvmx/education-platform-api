const express = require('express')
const { protect, restrictTo } = require('../middleware/auth')
const adminController = require('../controllers/admin.controller')

const router = express.Router()

// Protect all routes after this middleware
router.use(protect)
router.use(restrictTo('admin'))


const { createUser, getUsers, deleteUser, updateUserRole } = adminController

router.route('/users').post(createUser).get(getUsers)

router.route('/users/:userId').delete(deleteUser).patch(updateUserRole) 

module.exports = router