const Joi = require('joi')
const mongoose = require('mongoose')
const { Payment, Course, Module, User, Discount } = require('../models')
const { AppError } = require('../utils/errors')
const { initiatePayment, validatePayment } = require('../utils/sslcommerz')
const crypto = require('crypto')

// Validation Schemas
const initiatePaymentSchema = Joi.object({
  discountCode: Joi.string().trim(),
  redirectUrl: Joi.string().uri().required()
}).options({ abortEarly: false })

const initiateModulePaymentSchema = Joi.object({
  moduleIds: Joi.array().items(
    Joi.string().regex(/^[0-9a-fA-F]{24}$/)
  ).min(1).required(),
  discountCode: Joi.string().trim(),
  redirectUrl: Joi.string().uri().required()
}).options({ abortEarly: false })

const refundSchema = Joi.object({
  reason: Joi.string().required()
}).options({ abortEarly: false })

// Helper function to calculate discounted amount
async function calculateDiscountedAmount(amount, discountCode, courseId, moduleId = null) {
  if (!discountCode) return { discountedAmount: amount, discount: null }

  const discount = await Discount.findOne({
    code: discountCode.toUpperCase(),
    $or: [
      { course: courseId },
      { module: moduleId },
      { course: null, module: null } // Global discount
    ],
    startDate: { $lte: new Date() },
    endDate: { $gte: new Date() },
    usedCount: { $lt: { $ifNull: ['$maxUses', Number.MAX_SAFE_INTEGER] } },
    isDeleted: false
  })

  if (!discount) return { discountedAmount: amount, discount: null }

  const discountAmount = discount.type === 'percentage' 
    ? (amount * discount.value) / 100
    : discount.value

  return {
    discountedAmount: Math.max(0, amount - discountAmount),
    discount: discount._id
  }
}

// Helper function to verify course/module access
async function verifyAccess(userId, courseId, moduleIds = []) {
  const enrollment = await User.findOne(
    {
      _id: userId,
      'enrolledCourses.course': courseId
    },
    { 'enrolledCourses.$': 1 }
  )

  if (!enrollment) return true

  const enrolledCourse = enrollment.enrolledCourses[0]
  
  if (enrolledCourse.enrollmentType === 'full') {
    return false
  }

  if (moduleIds.length > 0) {
    const enrolledModuleIds = enrolledCourse.enrolledModules.map(em => 
      em.module.toString()
    )
    
    return !moduleIds.every(moduleId => 
      enrolledModuleIds.includes(moduleId.toString())
    )
  }

  return true
}

exports.initiateCoursePayment = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { error, value } = initiatePaymentSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map(detail => ({
          field: detail.context.key,
          message: detail.message
        }))
      })
    }

    const course = await Course.findOne({
      _id: req.params.courseId,
      isDeleted: false
    }).session(session)

    if (!course) {
      await session.abortTransaction()
      return next(new AppError('Course not found', 404))
    }

    // Check if user already has full access
    const hasAccess = !await verifyAccess(req.user._id, course._id)
    if (hasAccess) {
      await session.abortTransaction()
      return next(new AppError('You already have access to this course', 400))
    }

    // Calculate discounted amount if discount code provided
    const { discountedAmount, discount } = await calculateDiscountedAmount(
      course.price,
      value.discountCode,
      course._id
    )

    // Generate unique transaction ID
    const transactionId = crypto.randomBytes(16).toString('hex')

    // Create payment record
    const payment = await Payment.create([{
      user: req.user._id,
      course: course._id,
      purchaseType: 'course',
      amount: course.price,
      discount,
      discountedAmount,
      transactionId,
      status: 'pending'
    }], { session })

    // Prepare SSLCommerz data
    const sslData = {
      total_amount: discountedAmount,
      currency: 'BDT',
      tran_id: transactionId,
      success_url: `${value.redirectUrl}?status=success&tran_id=${transactionId}`,
      fail_url: `${value.redirectUrl}?status=fail&tran_id=${transactionId}`,
      cancel_url: `${value.redirectUrl}?status=cancel&tran_id=${transactionId}`,
      ipn_url: `${process.env.API_URL}/api/payments/ipn`,
      shipping_method: 'NO',
      product_name: course.title,
      product_category: 'Course',
      product_profile: 'general',
      cus_name: `${req.user.firstName} ${req.user.lastName}`,
      cus_email: req.user.email,
      cus_add1: 'Customer Address',
      cus_city: 'Customer City',
      cus_country: 'Bangladesh'
    }

    // Initiate SSLCommerz payment
    const sslResponse = await initiatePayment(sslData)

    // Update payment record with SSLCommerz session
    await Payment.findByIdAndUpdate(
      payment[0]._id,
      { sslcommerzSessionKey: sslResponse.sessionkey },
      { session }
    )

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      data: {
        gatewayRedirectUrl: sslResponse.GatewayPageURL,
        transactionId
      }
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.initiateModulePayment = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { error, value } = initiateModulePaymentSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map(detail => ({
          field: detail.context.key,
          message: detail.message
        }))
      })
    }

    const { moduleIds } = value

    // Find course and requested modules
    const [course, modules] = await Promise.all([
      Course.findOne({
        _id: req.params.courseId,
        isDeleted: false
      }).session(session),
      Module.find({
        _id: { $in: moduleIds },
        course: req.params.courseId,
        isDeleted: false
      }).session(session)
    ])

    if (!course) {
      await session.abortTransaction()
      return next(new AppError('Course not found', 404))
    }

    if (modules.length !== moduleIds.length) {
      await session.abortTransaction()
      return next(new AppError('One or more modules not found', 404))
    }

    // Check if user already has access to these modules
    const hasAccess = !await verifyAccess(req.user._id, course._id, moduleIds)
    if (hasAccess) {
      await session.abortTransaction()
      return next(new AppError('You already have access to these modules', 400))
    }

    // Calculate total amount
    const totalAmount = course.modulePrice * modules.length

    // Calculate discounted amount if discount code provided
    const { discountedAmount, discount } = await calculateDiscountedAmount(
      totalAmount,
      value.discountCode,
      course._id
    )

    // Generate unique transaction ID
    const transactionId = crypto.randomBytes(16).toString('hex')

    // Create payment record
    const payment = await Payment.create([{
      user: req.user._id,
      course: course._id,
      purchaseType: 'module',
      modules: moduleIds,
      amount: totalAmount,
      discount,
      discountedAmount,
      transactionId,
      status: 'pending'
    }], { session })

    // Prepare SSLCommerz data
    const sslData = {
      total_amount: discountedAmount,
      currency: 'BDT',
      tran_id: transactionId,
      success_url: `${value.redirectUrl}?status=success&tran_id=${transactionId}`,
      fail_url: `${value.redirectUrl}?status=fail&tran_id=${transactionId}`,
      cancel_url: `${value.redirectUrl}?status=cancel&tran_id=${transactionId}`,
      ipn_url: `${process.env.API_URL}/api/payments/ipn`,
      shipping_method: 'NO',
      product_name: `${course.title} - Modules`,
      product_category: 'Course Modules',
      product_profile: 'general',
      cus_name: `${req.user.firstName} ${req.user.lastName}`,
      cus_email: req.user.email,
      cus_add1: 'Customer Address',
      cus_city: 'Customer City',
      cus_country: 'Bangladesh'
    }

    // Initiate SSLCommerz payment
    const sslResponse = await initiatePayment(sslData)

    // Update payment record with SSLCommerz session
    await Payment.findByIdAndUpdate(
      payment[0]._id,
      { sslcommerzSessionKey: sslResponse.sessionkey },
      { session }
    )

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      data: {
        gatewayRedirectUrl: sslResponse.GatewayPageURL,
        transactionId
      }
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.verifyPayment = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { tran_id, status } = req.body

    const payment = await Payment.findOne({
      transactionId: tran_id,
      status: 'pending'
    }).session(session)

    if (!payment) {
      await session.abortTransaction()
      return next(new AppError('Invalid transaction', 400))
    }

    if (status !== 'VALID') {
      payment.status = 'failed'
      payment.validationResponse = req.body
      await payment.save({ session })

      await session.commitTransaction()

      return res.status(200).json({
        status: 'success',
        data: {
          verified: false,
          message: 'Payment validation failed'
        }
      })
    }

    // Validate payment with SSLCommerz
    const validationResponse = await validatePayment({ val_id: req.body.val_id })
    payment.validationResponse = validationResponse

    if (validationResponse.status !== 'VALID') {
      payment.status = 'failed'
      await payment.save({ session })

      await session.commitTransaction()

      return res.status(200).json({
        status: 'success',
        data: {
          verified: false,
          message: 'Payment validation failed'
        }
      })
    }

    // Update payment status
    payment.status = 'completed'
    await payment.save({ session })

    // Update user enrollment
    const updateQuery = payment.purchaseType === 'course'
      ? {
          $push: {
            enrolledCourses: {
              course: payment.course,
              enrollmentType: 'full',
              enrolledModules: []
            }
          }
        }
      : {
          $push: {
            'enrolledCourses.$[course].enrolledModules': {
              $each: payment.modules.map(moduleId => ({
                module: moduleId,
                completedLessons: [],
                completedQuizzes: []
              }))
            }
          }
        }

    const arrayFilters = payment.purchaseType === 'module'
      ? [{ 'course.course': payment.course }]
      : undefined

    await User.updateOne(
      { _id: payment.user },
      updateQuery,
      {
        arrayFilters,
        session,
        upsert: true
      }
    )

    // Update course total students if new enrollment
    if (payment.purchaseType === 'course') {
      await Course.updateOne(
        { _id: payment.course },
        { $inc: { totalStudents: 1 } },
        { session }
      )
    }

    // Update discount usage if applicable
    if (payment.discount) {
      await Discount.updateOne(
        { _id: payment.discount },
        { $inc: { usedCount: 1 } },
        { session }
      )
    }

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      data: {
        verified: true,
        enrollment: {
          type: payment.purchaseType,
          courseId: payment.course,
          moduleIds: payment.modules
        }
      }
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.handleIPN = async (req, res) => {
  try {
    const payment = await Payment.findOne({
      transactionId: req.body.tran_id,
      status: 'pending'
    })

    if (payment) {
      payment.ipnResponse = req.body
      await payment.save()
    }

    res.status(200).send('IPN_RECEIVED')
  } catch (error) {
    console.error('IPN Error:', error)
    res.status(500).send('IPN_ERROR')
  }
}

exports.getPaymentHistory = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1)
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100)
    const status = req.query.status

    const query = { user: req.user._id }
    if (status && ['pending', 'completed', 'failed', 'refunded'].includes(status)) {
      query.status = status
    }

    const [totalPayments, payments] = await Promise.all([
      Payment.countDocuments(query),
      Payment.find(query)
        .select('-sslcommerzSessionKey -ipnResponse -validationResponse')
        .populate([
          {
            path: 'course',
            select: 'title thumbnail',
          },
          {
            path: 'modules',
            select: 'title',
          },
          {
            path: 'discount',
            select: 'code type value',
          },
        ])
        .sort('-createdAt')
        .skip((page - 1) * limit)
        .limit(limit),
    ])

    const totalPages = Math.ceil(totalPayments / limit)

    res.status(200).json({
      status: 'success',
      data: {
        payments,
        pagination: {
          currentPage: page,
          totalPages,
          totalPayments,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    })
  } catch (error) {
    next(error)
  }
}

exports.requestRefund = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { error, value } = refundSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
    }

    const payment = await Payment.findOne({
      _id: req.params.paymentId,
      user: req.user._id,
      status: 'completed',
    }).session(session)

    if (!payment) {
      await session.abortTransaction()
      return next(new AppError('Payment not found or not eligible for refund', 404))
    }

    // Check refund eligibility (e.g., time limit)
    const refundTimeLimit = 30 * 24 * 60 * 60 * 1000 // 30 days
    if (Date.now() - payment.createdAt > refundTimeLimit) {
      await session.abortTransaction()
      return next(new AppError('Refund time limit exceeded', 400))
    }

    // Update payment status
    payment.status = 'refunded'
    await payment.save({ session })

    // Remove course/module access
    if (payment.purchaseType === 'course') {
      await User.updateOne(
        { _id: req.user._id },
        {
          $pull: {
            enrolledCourses: { course: payment.course },
          },
        },
        { session }
      )

      // Decrement course total students
      await Course.updateOne({ _id: payment.course }, { $inc: { totalStudents: -1 } }, { session })
    } else {
      await User.updateOne(
        {
          _id: req.user._id,
          'enrolledCourses.course': payment.course,
        },
        {
          $pull: {
            'enrolledCourses.$.enrolledModules': {
              module: { $in: payment.modules },
            },
          },
        },
        { session }
      )
    }

    // Revert discount usage if applicable
    if (payment.discount) {
      await Discount.updateOne({ _id: payment.discount }, { $inc: { usedCount: -1 } }, { session })
    }

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      message: 'Refund request processed successfully',
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.verifyCoupon = async (req, res, next) => {
  try {
    const { courseId, moduleId, code } = req.query

    if (!code) {
      return next(new AppError('Discount code is required', 400))
    }

    const course = await Course.findOne({
      _id: courseId,
      isDeleted: false,
    })

    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    if (moduleId) {
      const module = await Module.findOne({
        _id: moduleId,
        course: courseId,
        isDeleted: false,
      })

      if (!module) {
        return next(new AppError('Module not found', 404))
      }
    }

    const discount = await Discount.findOne({
      code: code.toUpperCase(),
      $or: [{ course: courseId }, { module: moduleId }, { course: null, module: null }],
      startDate: { $lte: new Date() },
      endDate: { $gte: new Date() },
      usedCount: { $lt: { $ifNull: ['$maxUses', Number.MAX_SAFE_INTEGER] } },
      isDeleted: false,
    })

    if (!discount) {
      return next(new AppError('Invalid or expired discount code', 400))
    }

    const amount = moduleId ? course.modulePrice : course.price
    const discountAmount = discount.type === 'percentage' ? (amount * discount.value) / 100 : discount.value

    res.status(200).json({
      status: 'success',
      data: {
        discount: {
          code: discount.code,
          type: discount.type,
          value: discount.value,
          discountedAmount: Math.max(0, amount - discountAmount),
        },
      },
    })
  } catch (error) {
    next(error)
  }
}