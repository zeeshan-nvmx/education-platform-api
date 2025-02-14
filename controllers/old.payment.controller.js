// payment.controller.js
const Joi = require('joi')
const mongoose = require('mongoose')
const { Payment, Course, Module, User, Discount } = require('../models')
const { AppError } = require('../utils/errors')
const { initiatePayment, validatePayment } = require('../utils/sslcommerz')
const crypto = require('crypto')

// validation schemas 
const initiatePaymentSchema = Joi.object({
  redirectUrl: Joi.string().uri().required(),
  discountCode: Joi.string().trim(),
  shippingAddress: Joi.object({
    address: Joi.string().required(),
    city: Joi.string().required(),
    country: Joi.string().required(),
    phone: Joi.string().required()
  }).required()
}).options({ abortEarly: false })

const initiateModulePaymentSchema = Joi.object({
  moduleIds: Joi.array().items(
    Joi.string().regex(/^[0-9a-fA-F]{24}$/)
  ).min(1).required(),
  redirectUrl: Joi.string().uri().required(),
  discountCode: Joi.string().trim(),
  shippingAddress: Joi.object({
    address: Joi.string().required(),
    city: Joi.string().required(),
    country: Joi.string().required(),
    phone: Joi.string().required()
  }).required()
}).options({ abortEarly: false })

// Schema for SSLCommerz redirect verification
const verifyPaymentSchema = Joi.object({
  tran_id: Joi.string().required(),
  val_id: Joi.string().required(),
  status: Joi.string().required()
}).options({ abortEarly: false })


const refundSchema = Joi.object({
  reason: Joi.string().required(),
}).options({ abortEarly: false })

// Helper function to calculate discounted amount
async function calculateDiscountedAmount(amount, discountCode, courseId, moduleId = null) {
  if (!discountCode) return { discountedAmount: amount, discount: null }

  const discount = await Discount.findOne({
    code: discountCode.toUpperCase(),
    $or: [
      { course: courseId },
      { module: moduleId },
      { course: null, module: null }, // Global discount
    ],
    startDate: { $lte: new Date() },
    endDate: { $gte: new Date() },
    usedCount: { $lt: { $ifNull: ['$maxUses', Number.MAX_SAFE_INTEGER] } },
    isDeleted: false,
  })

  if (!discount) return { discountedAmount: amount, discount: null }

  const discountAmount = discount.type === 'percentage' ? (amount * discount.value) / 100 : discount.value

  return {
    discountedAmount: Math.max(0, amount - discountAmount),
    discount: discount._id,
  }
}

// Helper function to verify course/module access with improved checks
async function verifyAccess(userId, courseId, moduleIds = []) {
  const enrollment = await User.findOne(
    {
      _id: userId,
      'enrolledCourses.course': courseId,
    },
    { 'enrolledCourses.$': 1 }
  )

  if (!enrollment) return true

  const enrolledCourse = enrollment.enrolledCourses[0]

  // If user has full course access, they can't purchase again
  if (enrolledCourse.enrollmentType === 'full') {
    return false
  }

  // For module purchase, check existing module access
  if (moduleIds.length > 0) {
    const enrolledModuleIds = enrolledCourse.enrolledModules.map((em) => em.module.toString())

    // Return false if user has access to any of the requested modules
    return !moduleIds.some((moduleId) => enrolledModuleIds.includes(moduleId.toString()))
  }

  return true
}

// Helper function to handle enrollment after successful payment
async function processEnrollment(userId, courseId, purchaseType, moduleIds = [], session) {
  const user = await User.findById(userId).session(session)
  const existingEnrollment = user.enrolledCourses.find((ec) => ec.course.toString() === courseId)

  if (purchaseType === 'course') {
    if (existingEnrollment) {
      // Update existing enrollment to full access
      existingEnrollment.enrollmentType = 'full'
      existingEnrollment.enrolledModules = []
    } else {
      // Create new full course enrollment
      user.enrolledCourses.push({
        course: courseId,
        enrollmentType: 'full',
        enrolledAt: new Date(),
        enrolledModules: [],
      })
    }
  } else {
    // Module purchase
    if (existingEnrollment) {
      // Add new modules to existing enrollment
      moduleIds.forEach((moduleId) => {
        if (!existingEnrollment.enrolledModules.some((em) => em.module.toString() === moduleId.toString())) {
          existingEnrollment.enrolledModules.push({
            module: moduleId,
            enrolledAt: new Date(),
            completedLessons: [],
            completedQuizzes: [],
            lastAccessed: new Date(),
          })
        }
      })
    } else {
      // Create new module-based enrollment
      user.enrolledCourses.push({
        course: courseId,
        enrollmentType: 'module',
        enrolledAt: new Date(),
        enrolledModules: moduleIds.map((moduleId) => ({
          module: moduleId,
          enrolledAt: new Date(),
          completedLessons: [],
          completedQuizzes: [],
          lastAccessed: new Date(),
        })),
      })
    }
  }

  await user.save({ session })
  return user
}

exports.initiateCoursePayment = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { error, value } = initiatePaymentSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
    }

    const course = await Course.findOne({
      _id: req.params.courseId,
      isDeleted: false,
    }).session(session)

    if (!course) {
      await session.abortTransaction()
      return next(new AppError('Course not found', 404))
    }

    // Check if user already has access
    const hasAccess = !(await verifyAccess(req.user._id, course._id))
    if (hasAccess) {
      await session.abortTransaction()
      return next(new AppError('You already have access to this course', 400))
    }

    // Calculate discounted amount if discount code provided
    const { discountedAmount, discount } = await calculateDiscountedAmount(course.price, value.discountCode, course._id)

    // Generate unique transaction ID
    const transactionId = crypto.randomBytes(16).toString('hex')

    // Prepare SSLCommerz required data
    const sslData = {
      store_id: process.env.SSLCOMMERZ_STORE_ID,
      store_passwd: process.env.SSLCOMMERZ_STORE_PASSWORD,
      total_amount: discountedAmount,
      currency: 'BDT',
      tran_id: transactionId,
      success_url: `${value.redirectUrl}?status=success`,
      fail_url: `${value.redirectUrl}?status=fail`,
      cancel_url: `${value.redirectUrl}?status=cancel`,
      ipn_url: `${process.env.API_URL}/api/v1/payments/ipn`,
      product_name: course.title,
      product_category: 'Course',
      product_profile: 'non-physical-goods',
      cus_name: `${req.user.firstName} ${req.user.lastName}`,
      cus_email: req.user.email,
      cus_add1: value.shippingAddress.address,
      cus_city: value.shippingAddress.city,
      cus_country: value.shippingAddress.country,
      cus_phone: value.shippingAddress.phone,
      shipping_method: 'NO',
      num_of_item: 1,
      emi_option: 0,
      value_a: course._id.toString(), // Course ID
      value_b: 'course', // Purchase type
      value_c: req.user._id.toString(), // User ID
    }

    // Create payment record
    const payment = await Payment.create(
      [
        {
          user: req.user._id,
          course: course._id,
          purchaseType: 'course',
          amount: course.price,
          discount,
          discountedAmount,
          transactionId,
          customerDetails: {
            name: `${req.user.firstName} ${req.user.lastName}`,
            email: req.user.email,
            ...value.shippingAddress,
          },
          status: 'pending',
          createdAt: new Date(),
        },
      ],
      { session }
    )

    // Initiate SSLCommerz payment
    const sslResponse = await initiatePayment(sslData)

    // Validate SSLCommerz response
    if (!sslResponse?.GatewayPageURL || !sslResponse?.sessionkey) {
      await session.abortTransaction()
      return next(new AppError('Failed to initialize payment gateway', 500))
    }

    // Update payment record with SSLCommerz session
    await Payment.findByIdAndUpdate(
      payment[0]._id,
      {
        sslcommerzSessionKey: sslResponse.sessionkey,
        gatewayPageURL: sslResponse.GatewayPageURL,
      },
      { session }
    )

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      data: {
        transactionId,
        amount: discountedAmount,
        gatewayRedirectURL: sslResponse.GatewayPageURL,
      },
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
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
    }

    const { moduleIds } = value

    // Find course and validate modules
    const [course, modules] = await Promise.all([
      Course.findOne({
        _id: req.params.courseId,
        isDeleted: false,
      }).session(session),
      Module.find({
        _id: { $in: moduleIds },
        course: req.params.courseId,
        isDeleted: false,
      }).session(session),
    ])

    if (!course) {
      await session.abortTransaction()
      return next(new AppError('Course not found', 404))
    }

    if (modules.length !== moduleIds.length) {
      await session.abortTransaction()
      return next(new AppError('One or more modules not found', 404))
    }

    // Check if user already has access
    const hasAccess = !(await verifyAccess(req.user._id, course._id, moduleIds))
    if (hasAccess) {
      await session.abortTransaction()
      return next(new AppError('You already have access to one or more of these modules', 400))
    }

    // Calculate total amount
    const totalAmount = course.modulePrice * modules.length

    // Calculate discounted amount if discount code provided
    const { discountedAmount, discount } = await calculateDiscountedAmount(totalAmount, value.discountCode, course._id)

    // Generate unique transaction ID
    const transactionId = crypto.randomBytes(16).toString('hex')

    // Prepare SSLCommerz required data
    const sslData = {
      store_id: process.env.SSLCOMMERZ_STORE_ID,
      store_passwd: process.env.SSLCOMMERZ_STORE_PASSWORD,
      total_amount: discountedAmount,
      currency: 'BDT',
      tran_id: transactionId,
      success_url: `${value.redirectUrl}?status=success`,
      fail_url: `${value.redirectUrl}?status=fail`,
      cancel_url: `${value.redirectUrl}?status=cancel`,
      ipn_url: `${process.env.API_URL}/api/v1/payments/ipn`,
      product_name: `${course.title} - ${modules.length} Modules`,
      product_category: 'Course Modules',
      product_profile: 'non-physical-goods',
      cus_name: `${req.user.firstName} ${req.user.lastName}`,
      cus_email: req.user.email,
      cus_add1: value.shippingAddress.address,
      cus_city: value.shippingAddress.city,
      cus_country: value.shippingAddress.country,
      cus_phone: value.shippingAddress.phone,
      shipping_method: 'NO',
      num_of_item: modules.length,
      emi_option: 0,
      value_a: course._id.toString(), // Course ID
      value_b: 'module', // Purchase type
      value_c: req.user._id.toString(), // User ID
      value_d: moduleIds.join(','), // Module IDs
    }

    // Create payment record
    const payment = await Payment.create(
      [
        {
          user: req.user._id,
          course: course._id,
          purchaseType: 'module',
          modules: moduleIds,
          amount: totalAmount,
          discount,
          discountedAmount,
          transactionId,
          customerDetails: {
            name: `${req.user.firstName} ${req.user.lastName}`,
            email: req.user.email,
            ...value.shippingAddress,
          },
          status: 'pending',
          createdAt: new Date(),
        },
      ],
      { session }
    )

    // Initiate SSLCommerz payment
    const sslResponse = await initiatePayment(sslData)

    // Validate SSLCommerz response
    if (!sslResponse?.GatewayPageURL || !sslResponse?.sessionkey) {
      await session.abortTransaction()
      return next(new AppError('Failed to initialize payment gateway', 500))
    }

    // Update payment record with SSLCommerz session
    await Payment.findByIdAndUpdate(
      payment[0]._id,
      {
        sslcommerzSessionKey: sslResponse.sessionkey,
        gatewayPageURL: sslResponse.GatewayPageURL,
      },
      { session }
    )

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      data: {
        transactionId,
        amount: discountedAmount,
        gatewayRedirectURL: sslResponse.GatewayPageURL,
      },
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
    // These parameters come from SSLCommerz redirect
    const { error, value } = verifyPaymentSchema.validate(req.query)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
    }

    const { tran_id, val_id, status } = value

    const payment = await Payment.findOne({
      transactionId: tran_id,
      status: 'pending',
    }).session(session)

    if (!payment) {
      await session.abortTransaction()
      return next(new AppError('Invalid transaction', 400))
    }

    if (status !== 'VALID') {
      payment.status = 'failed'
      payment.validationResponse = req.query
      await payment.save({ session })

      await session.commitTransaction()

      return res.status(200).json({
        status: 'success',
        data: {
          verified: false,
          message: 'Payment validation failed',
          transactionId: tran_id,
        },
      })
    }

    // Verify with SSLCommerz
    const validationResponse = await validatePayment({ val_id })
    payment.validationResponse = validationResponse

    if (validationResponse.status !== 'VALID') {
      payment.status = 'failed'
      await payment.save({ session })

      await session.commitTransaction()

      return res.status(200).json({
        status: 'success',
        data: {
          verified: false,
          message: 'Gateway validation failed',
          transactionId: tran_id,
        },
      })
    }

    // Process enrollment if payment is valid
    await processEnrollment(payment.user, payment.course, payment.purchaseType, payment.modules || [], session)

    // Update payment status
    payment.status = 'completed'
    payment.completedAt = new Date()
    await payment.save({ session })

    // Update course total students if needed
    const existingEnrollment = await User.findOne({
      _id: payment.user,
      'enrolledCourses.course': payment.course,
    }).session(session)

    if (!existingEnrollment) {
      await Course.updateOne({ _id: payment.course }, { $inc: { totalStudents: 1 } }, { session })
    }

    // Update discount usage if applicable
    if (payment.discount) {
      await Discount.updateOne({ _id: payment.discount }, { $inc: { usedCount: 1 } }, { session })
    }

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      data: {
        verified: true,
        transactionId: tran_id,
        amount: payment.discountedAmount || payment.amount,
        purchaseType: payment.purchaseType,
        courseId: payment.course,
        moduleIds: payment.modules,
        completedAt: payment.completedAt,
      },
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.handleIPN = async (req, res) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const payment = await Payment.findOne({
      transactionId: req.body.tran_id,
      status: 'pending',
    }).session(session)

    if (payment) {
      payment.ipnResponse = req.body
      payment.lastIpnReceived = new Date()

      if (req.body.status === 'VALID' && !payment.validationResponse) {
        const validationResponse = await validatePayment({
          val_id: req.body.val_id,
        })

        if (validationResponse.status === 'VALID') {
          payment.status = 'completed'
          payment.validationResponse = validationResponse
          payment.completedAt = new Date()

          // Process enrollment
          await processEnrollment(payment.user, payment.course, payment.purchaseType, payment.modules || [], session)

          // Update course total students
          const existingEnrollment = await User.findOne({
            _id: payment.user,
            'enrolledCourses.course': payment.course,
          }).session(session)

          if (!existingEnrollment) {
            await Course.updateOne({ _id: payment.course }, { $inc: { totalStudents: 1 } }, { session })
          }

          // Update discount usage
          if (payment.discount) {
            await Discount.updateOne({ _id: payment.discount }, { $inc: { usedCount: 1 } }, { session })
          }
        }
      }

      await payment.save({ session })
      await session.commitTransaction()
    }

    res.status(200).send('IPN_RECEIVED')
  } catch (error) {
    await session.abortTransaction()
    console.error('IPN Error:', error)
    res.status(500).send('IPN_ERROR')
  } finally {
    session.endSession()
  }
}

exports.getPaymentHistory = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1)
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100)
    const status = req.query.status
    const startDate = req.query.startDate ? new Date(req.query.startDate) : null
    const endDate = req.query.endDate ? new Date(req.query.endDate) : null

    const query = { user: req.user._id }

    if (status && ['pending', 'completed', 'failed', 'refunded'].includes(status)) {
      query.status = status
    }

    if (startDate || endDate) {
      query.createdAt = {}
      if (startDate) query.createdAt.$gte = startDate
      if (endDate) query.createdAt.$lte = endDate
    }

    const [totalPayments, payments] = await Promise.all([
      Payment.countDocuments(query),
      Payment.find(query)
        .select('-sslcommerzSessionKey -ipnResponse -validationResponse')
        .populate([
          {
            path: 'course',
            select: 'title thumbnail price modulePrice',
            match: { isDeleted: false },
          },
          {
            path: 'modules',
            select: 'title order',
            match: { isDeleted: false },
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

    const processedPayments = payments.map((payment) => {
      const paymentObj = payment.toObject()
      return {
        ...paymentObj,
        customerDetails: payment.customerDetails,
        savedAmount: payment.amount - (payment.discountedAmount || payment.amount),
        paymentDate: payment.createdAt,
        completedDate: payment.completedAt,
        gatewayPageURL: payment.gatewayPageURL,
        moduleCount: payment.modules?.length || 0,
      }
    })

    res.status(200).json({
      status: 'success',
      data: {
        payments: processedPayments,
        pagination: {
          currentPage: page,
          totalPages,
          totalPayments,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
        summary: {
          totalSpent: processedPayments.reduce((sum, p) => (p.status === 'completed' ? sum + (p.discountedAmount || p.amount) : sum), 0),
          totalSaved: processedPayments.reduce((sum, p) => (p.status === 'completed' ? sum + p.savedAmount : sum), 0),
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

    const refundTimeLimit = 30 * 24 * 60 * 60 * 1000 // 30 days
    if (Date.now() - payment.createdAt > refundTimeLimit) {
      await session.abortTransaction()
      return next(new AppError('Refund time limit exceeded', 400))
    }

    payment.status = 'refunded'
    payment.refundReason = value.reason
    payment.refundedAt = new Date()
    await payment.save({ session })

    // Handle access removal
    const user = await User.findById(req.user._id).session(session)
    const enrollmentIndex = user.enrolledCourses.findIndex((ec) => ec.course.toString() === payment.course.toString())

    if (enrollmentIndex !== -1) {
      if (payment.purchaseType === 'course') {
        // Remove entire course enrollment
        user.enrolledCourses.splice(enrollmentIndex, 1)

        await Course.updateOne({ _id: payment.course }, { $inc: { totalStudents: -1 } }, { session })
      } else {
        // Remove specific modules
        const enrollment = user.enrolledCourses[enrollmentIndex]
        enrollment.enrolledModules = enrollment.enrolledModules.filter((em) => !payment.modules.includes(em.module.toString()))

        if (enrollment.enrolledModules.length === 0) {
          user.enrolledCourses.splice(enrollmentIndex, 1)
          await Course.updateOne({ _id: payment.course }, { $inc: { totalStudents: -1 } }, { session })
        }
      }

      await user.save({ session })
    }

    if (payment.discount) {
      await Discount.updateOne({ _id: payment.discount }, { $inc: { usedCount: -1 } }, { session })
    }

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      data: {
        refundId: payment._id,
        amount: payment.amount,
        refundedAmount: payment.discountedAmount || payment.amount,
        refundedAt: payment.refundedAt,
      },
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}


// Verify Coupon
exports.verifyCoupon = async (req, res, next) => {
  try {
    const { courseId, moduleId, code } = req.query

    if (!code) {
      return next(new AppError('Discount code is required', 400))
    }

    // Validate course and module if provided
    const course = await Course.findOne({
      _id: courseId,
      isDeleted: false
    })

    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    let module = null
    if (moduleId) {
      module = await Module.findOne({
        _id: moduleId,
        course: courseId,
        isDeleted: false
      })

      if (!module) {
        return next(new AppError('Module not found', 404))
      }
    }

    // Find valid discount
    const discount = await Discount.findOne({
      code: code.toUpperCase(),
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

    if (!discount) {
      return next(new AppError('Invalid or expired discount code', 400))
    }

    // Calculate discount
    const originalAmount = moduleId ? course.modulePrice : course.price
    const discountAmount = discount.type === 'percentage' 
      ? (originalAmount * discount.value) / 100
      : discount.value

    const discountedAmount = Math.max(0, originalAmount - discountAmount)

    // Check if user has already used this discount
    const existingPayment = await Payment.findOne({
      user: req.user._id,
      discount: discount._id,
      status: { $in: ['completed', 'pending'] }
    })

    res.status(200).json({
      status: 'success',
      data: {
        discount: {
          code: discount.code,
          type: discount.type,
          value: discount.value,
          originalAmount,
          discountAmount,
          discountedAmount,
          savings: originalAmount - discountedAmount,
          hasBeenUsed: !!existingPayment,
          expiresAt: discount.endDate
        }
      }
    })
  } catch (error) {
    next(error)
  }
}

// Export IPN URL as a constant for route configuration
exports.IPN_URL = `${process.env.API_URL}/api/payments/ipn`

