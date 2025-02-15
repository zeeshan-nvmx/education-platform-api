const Joi = require('joi')
const mongoose = require('mongoose')
const { Payment, Course, Module, User, Discount } = require('../models')
const { AppError } = require('../utils/errors')
const { initiatePayment, validatePayment } = require('../utils/sslcommerz')
const crypto = require('crypto')

// Validation schemas remain the same as they are well structured
const initiatePaymentSchema = Joi.object({
  redirectUrl: Joi.string().uri().required(),
  discountCode: Joi.string().trim(),
  shippingAddress: Joi.object({
    address: Joi.string().required(),
    city: Joi.string().required(),
    country: Joi.string().required(),
    phone: Joi.string().required(),
  }).required(),
}).options({ abortEarly: false })

const initiateModulePaymentSchema = Joi.object({
  moduleIds: Joi.array()
    .items(Joi.string().regex(/^[0-9a-fA-F]{24}$/))
    .min(1)
    .required(),
  redirectUrl: Joi.string().uri().required(),
  discountCode: Joi.string().trim(),
  shippingAddress: Joi.object({
    address: Joi.string().required(),
    city: Joi.string().required(),
    country: Joi.string().required(),
    phone: Joi.string().required(),
  }).required(),
}).options({ abortEarly: false })

// const verifyPaymentSchema = Joi.object({
//   tran_id: Joi.string().required(),
//   val_id: Joi.string().required(),
//   status: Joi.string().required(),
// }).options({ abortEarly: false })

// Helper function to calculate discounted amount - remains the same as it's robust

const verifyPaymentSchema = Joi.object({
  tran_id: Joi.string().required(),
  val_id: Joi.string().required(),
  amount: Joi.string(),
  card_type: Joi.string(),
  store_amount: Joi.string(),
  card_no: Joi.string(),
  bank_tran_id: Joi.string(),
  status: Joi.string().required(),
  tran_date: Joi.string(),
  error: Joi.string(),
  currency: Joi.string(),
  card_issuer: Joi.string(),
  card_brand: Joi.string(),
  risk_level: Joi.string(),
  risk_title: Joi.string(),
}).options({ abortEarly: false, stripUnknown: true })

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

// Improved verifyAccess function with better error handling
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

  if (enrolledCourse.enrollmentType === 'full') {
    return false
  }

  if (moduleIds.length > 0) {
    const enrolledModuleIds = enrolledCourse.enrolledModules.map((em) => em.module.toString())
    return !moduleIds.some((moduleId) => enrolledModuleIds.includes(moduleId.toString()))
  }

  return true
}

// Enhanced processEnrollment function with better error handling
async function processEnrollment(userId, courseId, purchaseType, moduleIds = [], session) {
  const user = await User.findById(userId).session(session)
  if (!user) {
    throw new AppError('User not found', 404)
  }

  const existingEnrollment = user.enrolledCourses.find((ec) => ec.course.toString() === courseId)

  if (purchaseType === 'course') {
    if (existingEnrollment) {
      existingEnrollment.enrollmentType = 'full'
      existingEnrollment.enrolledModules = []
    } else {
      user.enrolledCourses.push({
        course: courseId,
        enrollmentType: 'full',
        enrolledAt: new Date(),
        enrolledModules: [],
      })
    }
  } else {
    // Module purchase
    if (!moduleIds.length) {
      throw new AppError('No modules specified for module purchase', 400)
    }

    if (existingEnrollment) {
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

    const hasAccess = !(await verifyAccess(req.user._id, course._id))
    if (hasAccess) {
      await session.abortTransaction()
      return next(new AppError('You already have access to this course', 400))
    }

    const { discountedAmount, discount } = await calculateDiscountedAmount(course.price, value.discountCode, course._id)
    const transactionId = crypto.randomBytes(16).toString('hex')

    const sslData = {
      store_id: process.env.SSLCOMMERZ_STORE_ID,
      store_passwd: process.env.SSLCOMMERZ_STORE_PASSWORD,
      total_amount: discountedAmount,
      currency: 'BDT',
      tran_id: transactionId,
      success_url: `${value.redirectUrl}/success`,
      fail_url: `${value.redirectUrl}/fail`,
      cancel_url: `${value.redirectUrl}/cancel`,
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
      value_a: course._id.toString(),
      value_b: 'course',
      value_c: req.user._id.toString(),
    }

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

    const sslResponse = await initiatePayment(sslData)

    if (!sslResponse?.GatewayPageURL || !sslResponse?.sessionkey) {
      await session.abortTransaction()
      return next(new AppError('Failed to initialize payment gateway', 500))
    }

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
      message: 'Payment initialized successfully',
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

    const hasAccess = !(await verifyAccess(req.user._id, course._id, moduleIds))
    if (hasAccess) {
      await session.abortTransaction()
      return next(new AppError('You already have access to one or more of these modules', 400))
    }

    const totalAmount = modules.reduce((sum, module) => sum + module.price, 0)
    const { discountedAmount, discount } = await calculateDiscountedAmount(totalAmount, value.discountCode, course._id)
    const transactionId = crypto.randomBytes(16).toString('hex')

    const sslData = {
      store_id: process.env.SSLCOMMERZ_STORE_ID,
      store_passwd: process.env.SSLCOMMERZ_STORE_PASSWORD,
      total_amount: discountedAmount,
      currency: 'BDT',
      tran_id: transactionId,
      success_url: `${value.redirectUrl}?status=success`,
      fail_url: `${value.redirectUrl}?status=fail`,
      cancel_url: `${value.redirectUrl}?status=cancel`,
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
      value_a: course._id.toString(),
      value_b: 'module',
      value_c: req.user._id.toString(),
      value_d: moduleIds.join(','),
    }

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

    const sslResponse = await initiatePayment(sslData)

    if (!sslResponse?.GatewayPageURL || !sslResponse?.sessionkey) {
      await session.abortTransaction()
      return next(new AppError('Failed to initialize payment gateway', 500))
    }

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

// exports.verifyPayment = async (req, res, next) => {
//   const session = await mongoose.startSession()
//   session.startTransaction()

//   try {
//     const { error, value } = verifyPaymentSchema.validate(req.query)
//     if (error) {
//       return res.status(400).json({
//         status: 'error',
//         errors: error.details.map((detail) => ({
//           field: detail.context.key,
//           message: detail.message,
//         })),
//       })
//     }

//     const { tran_id, val_id, status } = value

//     const payment = await Payment.findOne({
//       transactionId: tran_id,
//       status: 'pending',
//     }).session(session)

//     if (!payment) {
//       await session.abortTransaction()
//       return next(new AppError('Invalid transaction', 400))
//     }

//     if (status !== 'VALID') {
//       payment.status = 'failed'
//       payment.validationResponse = req.query
//       await payment.save({ session })

//       await session.commitTransaction()

//       return res.status(200).json({
//         status: 'success',
//         data: {
//           verified: false,
//           message: 'Payment validation failed',
//           transactionId: tran_id,
//         },
//       })
//     }

//     // Verify with SSLCommerz
//     const validationResponse = await validatePayment({ val_id })
//     payment.validationResponse = validationResponse

//     if (validationResponse.status !== 'VALID') {
//       payment.status = 'failed'
//       await payment.save({ session })

//       await session.commitTransaction()

//       return res.status(200).json({
//         status: 'success',
//         data: {
//           verified: false,
//           message: 'Gateway validation failed',
//           transactionId: tran_id,
//         },
//       })
//     }

//     // Process enrollment if payment is valid
//     await processEnrollment(payment.user, payment.course, payment.purchaseType, payment.modules || [], session)

//     // Update payment status
//     payment.status = 'completed'
//     payment.completedAt = new Date()
//     await payment.save({ session })

//     // Update course total students if needed
//     const existingEnrollment = await User.findOne({
//       _id: payment.user,
//       'enrolledCourses.course': payment.course,
//     }).session(session)

//     if (!existingEnrollment) {
//       await Course.updateOne({ _id: payment.course }, { $inc: { totalStudents: 1 } }, { session })
//     }

//     // Update discount usage if applicable
//     if (payment.discount) {
//       await Discount.updateOne({ _id: payment.discount }, { $inc: { usedCount: 1 } }, { session })
//     }

//     await session.commitTransaction()

//     res.status(200).json({
//       status: 'success',
//       data: {
//         verified: true,
//         transactionId: tran_id,
//         amount: payment.discountedAmount || payment.amount,
//         purchaseType: payment.purchaseType,
//         courseId: payment.course,
//         moduleIds: payment.modules,
//         completedAt: payment.completedAt,
//       },
//     })
//   } catch (error) {
//     await session.abortTransaction()
//     next(error)
//   } finally {
//     session.endSession()
//   }
// }

// Get payment history for a user

exports.verifyPayment = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    console.log('Payment verification request:', req.query)

    const { error, value } = verifyPaymentSchema.validate(req.query)
    if (error) {
      console.error('Validation error:', error.details)
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
    }

    const { tran_id, val_id, status, amount, bank_tran_id, card_type } = value

    // Find the pending payment
    const payment = await Payment.findOne({
      transactionId: tran_id,
      status: 'pending',
    }).session(session)

    if (!payment) {
      console.error('Payment not found:', tran_id)
      await session.abortTransaction()
      return next(new AppError('Invalid transaction', 400))
    }

    // Store the raw response
    payment.validationResponse = req.query

    // Handle non-successful status
    if (status !== 'VALID') {
      console.log('Payment status not valid:', status)
      payment.status = 'failed'
      await payment.save({ session })

      await session.commitTransaction()

      return res.status(200).json({
        status: 'success',
        message: 'Payment validation failed',
        data: {
          verified: false,
          message: 'Payment validation failed',
          transactionId: tran_id,
          amount: amount,
          bankTransactionId: bank_tran_id,
          paymentMethod: card_type,
        },
      })
    }

    // Verify with SSLCommerz
    console.log('Verifying with SSLCommerz:', val_id)
    const validationResponse = await validatePayment({ val_id })
    console.log('SSLCommerz validation response:', validationResponse)

    payment.validationResponse = {
      ...payment.validationResponse,
      sslcommerzValidation: validationResponse,
    }

    // Check SSLCommerz validation
    if (validationResponse.status !== 'VALID') {
      console.error('SSLCommerz validation failed:', validationResponse)
      payment.status = 'failed'
      await payment.save({ session })

      await session.commitTransaction()

      return res.status(200).json({
        status: 'success',
        message: 'Gateway validation failed',
        data: {
          verified: false,
          message: 'Gateway validation failed',
          transactionId: tran_id,
          details: validationResponse,
        },
      })
    }

    // Validate amount matches (convert to same format)
    const expectedAmount = payment.discountedAmount || payment.amount
    const receivedAmount = parseFloat(amount)

    if (receivedAmount !== expectedAmount) {
      console.error('Amount mismatch:', { expected: expectedAmount, received: receivedAmount })
      payment.status = 'failed'
      await payment.save({ session })

      await session.commitTransaction()
      return next(new AppError('Payment amount mismatch', 400))
    }

    try {
      // Process enrollment
      await processEnrollment(payment.user, payment.course, payment.purchaseType, payment.modules || [], session)

      // Update payment status
      payment.status = 'completed'
      payment.completedAt = new Date()
      payment.bankTransactionId = bank_tran_id
      payment.paymentMethod = card_type
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

      return res.status(200).json({
        status: 'success',
        message: 'Payment Successfully verified, congratulations!',
        data: {
          verified: true,
          transactionId: tran_id,
          amount: expectedAmount,
          bankTransactionId: bank_tran_id,
          paymentMethod: card_type,
          purchaseType: payment.purchaseType,
          courseId: payment.course,
          moduleIds: payment.modules,
          completedAt: payment.completedAt,
        },
      })
    } catch (enrollmentError) {
      console.error('Enrollment processing error:', enrollmentError)
      payment.status = 'failed'
      payment.validationResponse.enrollmentError = enrollmentError.message
      await payment.save({ session })

      await session.abortTransaction()
      throw enrollmentError
    }
  } catch (error) {
    console.error('Payment verification error:', error)
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.getPaymentHistory = async (req, res, next) => {
  try {
    const payments = await Payment.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .populate('course', 'title')
      .populate('modules', 'title')
      .select('-sslcommerzSessionKey -gatewayData')

    res.status(200).json({
      status: 'success',
      data: payments,
    })
  } catch (error) {
    next(error)
  }
}

// Get payment details
exports.getPaymentDetails = async (req, res, next) => {
  try {
    const payment = await Payment.findOne({
      _id: req.params.paymentId,
      user: req.user._id,
    })
      .populate('course', 'title')
      .populate('modules', 'title')
      .select('-sslcommerzSessionKey -gatewayData')

    if (!payment) {
      return next(new AppError('Payment not found', 404))
    }

    res.status(200).json({
      status: 'success',
      data: payment,
    })
  } catch (error) {
    next(error)
  }
}
