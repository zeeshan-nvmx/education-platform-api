const Joi = require('joi')
const mongoose = require('mongoose')
const { Course, Module, User, Progress, Lesson, Quiz } = require('../models')
const { AppError } = require('../utils/errors')
const { uploadToS3, deleteFromS3 } = require('../utils/s3')
const sanitizeHtml = require('sanitize-html')

const instructorSchema = Joi.object({
  name: Joi.string().required().trim(),
  description: Joi.string().required().trim(),
  designation: Joi.string().trim(),
  expertise: Joi.array().items(Joi.string().trim()),
  socialLinks: Joi.object({
    linkedin: Joi.string().uri().allow(''),
    twitter: Joi.string().uri().allow(''),
    website: Joi.string().uri().allow('')
  }),
  bio: Joi.string().trim(),
  achievements: Joi.array().items(Joi.string())
}).options({ stripUnknown: true })

const courseSchema = Joi.object({
  title: Joi.string().trim(),
  description: Joi.string().trim(),
  category: Joi.string().trim(),
  price: Joi.number().min(0),
  modulePrice: Joi.number().min(0),
  featured: Joi.boolean(),
  instructors: Joi.array().min(1).items(instructorSchema)
}).options({ abortEarly: false })

const querySchema = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
  category: Joi.string(),
  search: Joi.string(),
  minPrice: Joi.number().min(0),
  maxPrice: Joi.number().min(Joi.ref('minPrice')),
  sortBy: Joi.string().valid('createdAt', 'price', 'rating', 'totalStudents'),
  order: Joi.string().valid('asc', 'desc')
})

async function handleInstructorImages(instructors, instructorImages) {
  const processedInstructors = await Promise.all(instructors.map(async (instructor, index) => {
    const instructorImage = instructorImages?.[index]
    if (instructorImage) {
      const key = `instructor-images/${Date.now()}-${index}-${instructorImage.originalname}`
      const imageUrl = await uploadToS3(instructorImage, key)
      return { ...instructor, image: imageUrl, imageKey: key }
    }
    return instructor
  }))
  return processedInstructors
}

async function cleanupInstructorImages(imageKeys) {
  await Promise.all(
    imageKeys.map(key => deleteFromS3(key).catch(console.error))
  )
}

exports.createCourse = async (req, res, next) => {
  let uploadedImageKeys = []
  
  try {
    const courseData = JSON.parse(req.body.courseData)
    const { error, value } = courseSchema.validate(courseData)
    
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map(detail => ({
          field: detail.context.key,
          message: detail.message
        }))
      })
    }

    // Validate modulePrice against course price
    if (value.modulePrice > value.price) {
      return next(new AppError('Module price cannot be greater than course price', 400))
    }

    const existingCourse = await Course.findOne({ title: value.title })
    if (existingCourse) {
      return next(new AppError('A course with this title already exists', 400))
    }

    let thumbnailUrl = null
    let thumbnailKey = null
    if (req.files?.thumbnail?.[0]) {
      thumbnailKey = `course-thumbnails/${Date.now()}-${req.files.thumbnail[0].originalname}`
      thumbnailUrl = await uploadToS3(req.files.thumbnail[0], thumbnailKey)
      uploadedImageKeys.push(thumbnailKey)
    }

    const instructorsWithImages = await handleInstructorImages(
      value.instructors,
      req.files?.instructorImages
    )
    
    uploadedImageKeys = uploadedImageKeys.concat(
      instructorsWithImages
        .filter(inst => inst.imageKey)
        .map(inst => inst.imageKey)
    )

    value.description = sanitizeHtml(value.description, {
      allowedTags: ['b', 'i', 'em', 'strong', 'p', 'br'],
      allowedAttributes: {}
    })

    const course = await Course.create({
      ...value,
      thumbnail: thumbnailUrl,
      thumbnailKey,
      instructors: instructorsWithImages,
      creator: req.user._id
    })

    const populatedCourse = await Course.findById(course._id)
      .populate('creator', 'firstName lastName email')

    res.status(201).json({
      status: 'success',
      data: populatedCourse
    })
  } catch (error) {
    await cleanupInstructorImages(uploadedImageKeys)
    next(error)
  }
}

exports.getAllCourses = async (req, res, next) => {
  try {
    const { error, value } = querySchema.validate(req.query)
    if (error) {
      return next(new AppError(error.details[0].message, 400))
    }

    const {
      page = 1,
      limit = 10,
      category,
      search,
      minPrice,
      maxPrice,
      sortBy = 'createdAt',
      order = 'desc'
    } = value

    const query = { isDeleted: false }

    if (category) {
      query.category = category
    }

    if (search) {
      query.$text = { $search: search }
    }

    if (!isNaN(minPrice) || !isNaN(maxPrice)) {
      query.price = {}
      if (!isNaN(minPrice)) query.price.$gte = minPrice
      if (!isNaN(maxPrice)) query.price.$lte = maxPrice
    }

    const [totalCourses, courses] = await Promise.all([
      Course.countDocuments(query),
      Course.find(query)
        .select('-__v')
        .populate('creator', 'firstName lastName email')
        .sort({ [sortBy]: order === 'desc' ? -1 : 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
    ])

    const totalPages = Math.ceil(totalCourses / limit)

    res.status(200).json({
      status: 'success',
      data: {
        courses,
        pagination: {
          currentPage: page,
          totalPages,
          totalCourses,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        }
      }
    })
  } catch (error) {
    next(error)
  }
}

exports.getCourse = async (req, res, next) => {
  try {
    const course = await Course.findById(req.params.courseId)
      .populate('creator', 'firstName lastName email')
      .populate({
        path: 'modules',
        select: 'title description order prerequisites isAccessible dependencies',
        match: { isDeleted: false },
        options: { sort: { order: 1 } },
        populate: {
          path: 'lessons',
          select: 'title description order videoUrl duration requireQuizPass',
          match: { isDeleted: false },
          options: { sort: { order: 1 } }
        }
      })

    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    const isCreator = course.creator._id.toString() === req.user?._id.toString()
    const isAdmin = req.user?.role === 'admin'
    const enrollment = req.user?.enrolledCourses?.find(
      e => e.course.toString() === course._id.toString()
    )

    if (!isCreator && !isAdmin && !course.featured && !enrollment) {
      const limitedCourse = {
        _id: course._id,
        title: course.title,
        description: course.description,
        category: course.category,
        price: course.price,
        modulePrice: course.modulePrice,
        thumbnail: course.thumbnail,
        creator: course.creator,
        instructors: course.instructors.map(instructor => ({
          name: instructor.name,
          description: instructor.description,
          designation: instructor.designation,
          image: instructor.image,
          expertise: instructor.expertise,
          bio: instructor.bio,
          socialLinks: instructor.socialLinks
        })),
        rating: course.rating,
        totalStudents: course.totalStudents,
        featured: course.featured
      }

      return res.status(200).json({
        status: 'success',
        data: limitedCourse
      })
    }

    res.status(200).json({
      status: 'success',
      data: {
        ...course.toObject(),
        enrollmentType: enrollment?.enrollmentType,
        enrolledModules: enrollment?.enrolledModules?.map(m => m.module.toString())
      }
    })
  } catch (error) {
    next(error)
  }
}

exports.updateCourse = async (req, res, next) => {
  let newUploadedImageKeys = []
  
  try {
    const courseData = JSON.parse(req.body.courseData || '{}')
    const { error, value } = courseSchema.validate(courseData)
    
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map(detail => ({
          field: detail.context.key,
          message: detail.message
        }))
      })
    }

    if (Object.keys(value).length === 0 && !req.files) {
      return next(new AppError('No update data provided', 400))
    }

    const course = await Course.findById(req.params.courseId)
    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    if (value.modulePrice && value.modulePrice > (value.price || course.price)) {
      return next(new AppError('Module price cannot be greater than course price', 400))
    }

    if (req.files?.thumbnail?.[0]) {
      if (course.thumbnailKey) {
        await deleteFromS3(course.thumbnailKey).catch(console.error)
      }
      const thumbnailKey = `course-thumbnails/${Date.now()}-${req.files.thumbnail[0].originalname}`
      const thumbnailUrl = await uploadToS3(req.files.thumbnail[0], thumbnailKey)
      value.thumbnail = thumbnailUrl
      value.thumbnailKey = thumbnailKey
      newUploadedImageKeys.push(thumbnailKey)
    }

    if (value.instructors) {
      const oldInstructorImageKeys = course.instructors
        .filter(inst => inst.imageKey)
        .map(inst => inst.imageKey)

      const instructorsWithImages = await handleInstructorImages(
        value.instructors,
        req.files?.instructorImages
      )

      newUploadedImageKeys = newUploadedImageKeys.concat(
        instructorsWithImages
          .filter(inst => inst.imageKey)
          .map(inst => inst.imageKey)
      )

      value.instructors = instructorsWithImages
      await cleanupInstructorImages(oldInstructorImageKeys)
    }

    if (value.description) {
      value.description = sanitizeHtml(value.description, {
        allowedTags: ['b', 'i', 'em', 'strong', 'p', 'br'],
        allowedAttributes: {}
      })
    }

    if (value.title && value.title !== course.title) {
      const existingCourse = await Course.findOne({
        title: value.title,
        _id: { $ne: req.params.courseId }
      })
      if (existingCourse) {
        await cleanupInstructorImages(newUploadedImageKeys)
        return next(new AppError('A course with this title already exists', 400))
      }
    }

    const updatedCourse = await Course.findByIdAndUpdate(
      req.params.courseId,
      { ...value },
      { new: true, runValidators: true }
    ).populate('creator', 'firstName lastName email')

    res.status(200).json({
      status: 'success',
      data: updatedCourse
    })
  } catch (error) {
    await cleanupInstructorImages(newUploadedImageKeys)
    next(error)
  }
}

exports.deleteCourse = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const course = await Course.findById(req.params.courseId).session(session)
    if (!course) {
      await session.abortTransaction()
      return next(new AppError('Course not found', 404))
    }

    const activeEnrollments = await User.countDocuments({
      'enrolledCourses.course': course._id
    }).session(session)

    if (activeEnrollments > 0) {
      course.isDeleted = true
      await course.save({ session })

      await Promise.all([
        Module.updateMany({ course: course._id }, { isDeleted: true }, { session }),
        Lesson.updateMany(
          { module: { $in: await Module.find({ course: course._id }).distinct('_id') } },
          { isDeleted: true },
          { session }
        )
      ])
    } else {
      const imageKeys = [
        course.thumbnailKey,
        ...course.instructors
          .filter(inst => inst.imageKey)
          .map(inst => inst.imageKey)
      ].filter(Boolean)

      await cleanupInstructorImages(imageKeys)
      await Course.deleteOne({ _id: course._id }).session(session)

      const modules = await Module.find({ course: course._id })
      await Promise.all([
        Module.deleteMany({ course: course._id }).session(session),
        Lesson.deleteMany({
          module: { $in: modules.map(module => module._id) }
        }).session(session)
      ])
    }

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      message: 'Course deleted successfully'
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.getFeaturedCourses = async (req, res, next) => {
  try {
    const courses = await Course.find({ featured: true, isDeleted: false })
      .select('-__v')
      .populate('creator', 'firstName lastName')
      .sort('-rating')
      .limit(6)
      .lean()

    res.status(200).json({
      status: 'success',
      data: courses
    })
  } catch (error) {
    next(error)
  }
}

exports.getCoursesByCategory = async (req, res, next) => {
  try {
    const { category } = req.params
    const page = parseInt(req.query.page) || 1
    const limit = parseInt(req.query.limit) || 10

    const [totalCourses, courses] = await Promise.all([
      Course.countDocuments({ category, isDeleted: false }),
      Course.find({ category, isDeleted: false })
        .select('-__v')
        .populate('creator', 'firstName lastName')
        .sort('-createdAt')
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
    ])

    const totalPages = Math.ceil(totalCourses / limit)

    res.status(200).json({
      status: 'success',
      data: {
        courses,
        pagination: {
          currentPage: page,
          totalPages,
          totalCourses,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        }
      }
    })
  } catch (error) {
    next(error)
  }
}

exports.getCourseModules = async (req, res, next) => {
  try {
    const course = await Course.findById(req.params.courseId)
      .populate({
        path: 'modules',
        match: { isDeleted: false },
        select: 'title description order prerequisites isAccessible dependencies',
        options: { sort: { order: 1 } }
      })

    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    const enrollment = req.user.enrolledCourses?.find(
      e => e.course.toString() === course._id.toString()
    )

    const modules = course.modules.map(module => {
      const moduleObj = module.toObject()
      if (enrollment) {
        const enrolledModule = enrollment.enrolledModules.find(
          em => em.module.toString() === module._id.toString()
        )
        moduleObj.isEnrolled = !!enrolledModule
        moduleObj.progress = enrolledModule ? {
          completedLessons: enrolledModule.completedLessons,
          completedQuizzes: enrolledModule.completedQuizzes,
          lastAccessed: enrolledModule.lastAccessed
        } : null
      }
      return moduleObj
    })

    res.status(200).json({
      status: 'success',
      data: modules
    })
  } catch (error) {
    next(error)
  }
}

exports.checkModuleAccess = async (req, res, next) => {
  try {
    const { courseId, moduleId } = req.params

    const course = await Course.findById(courseId)
    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    const module = await Module.findOne({
      _id: moduleId,
      course: courseId,
      isDeleted: false
    })

    if (!module) {
      return next(new AppError('Module not found', 404))
    }

    const enrollment = req.user.enrolledCourses?.find(
      e => e.course.toString() === courseId
    )

    if (!enrollment) {
      return res.status(200).json({
        status: 'success',
        data: {
          hasAccess: false,
          reason: 'not_enrolled'
        }
      })
    }

    // Check if user has full course access
    if (enrollment.enrollmentType === 'full') {
      return res.status(200).json({
        status: 'success',
        data: {
          hasAccess: true,
          enrollmentType: 'full'
        }
      })
    }

    // Check if user has access to this specific module
    const moduleEnrollment = enrollment.enrolledModules.find(
      em => em.module.toString() === moduleId
    )

    if (!moduleEnrollment) {
      return res.status(200).json({
        status: 'success',
        data: {
          hasAccess: false,
          reason: 'module_not_purchased'
        }
      })
    }

    // Check prerequisites if any
    if (module.prerequisites?.length > 0) {
      const prerequisitesMet = await checkPrerequisites(module.prerequisites, enrollment)
      if (!prerequisitesMet) {
        return res.status(200).json({
          status: 'success',
          data: {
            hasAccess: false,
            reason: 'prerequisites_not_met'
          }
        })
      }
    }

    res.status(200).json({
      status: 'success',
      data: {
        hasAccess: true,
        enrollmentType: 'module',
        progress: {
          completedLessons: moduleEnrollment.completedLessons,
          completedQuizzes: moduleEnrollment.completedQuizzes,
          lastAccessed: moduleEnrollment.lastAccessed
        }
      }
    })
  } catch (error) {
    next(error)
  }
}

exports.getCourseProgress = async (req, res, next) => {
  try {
    const { courseId } = req.params

    const course = await Course.findById(courseId)
      .populate({
        path: 'modules',
        match: { isDeleted: false },
        select: 'title order',
        options: { sort: { order: 1 } },
        populate: {
          path: 'lessons',
          match: { isDeleted: false },
          select: '_id'
        }
      })

    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    const enrollment = req.user.enrolledCourses?.find(
      e => e.course.toString() === courseId
    )

    if (!enrollment) {
      return next(new AppError('You are not enrolled in this course', 403))
    }

    const totalLessons = course.modules.reduce(
      (total, module) => total + module.lessons.length,
      0
    )

    const moduleProgress = course.modules.map(module => {
      const enrolledModule = enrollment.enrolledModules.find(
        em => em.module.toString() === module._id.toString()
      )

      const completedLessonsCount = enrolledModule?.completedLessons.length || 0
      const totalModuleLessons = module.lessons.length

      return {
        moduleId: module._id,
        title: module.title,
        completedLessons: completedLessonsCount,
        totalLessons: totalModuleLessons,
        progress: totalModuleLessons > 0
          ? (completedLessonsCount / totalModuleLessons) * 100
          : 0
      }
    })

    const totalCompletedLessons = moduleProgress.reduce(
      (total, module) => total + module.completedLessons,
      0
    )

    res.status(200).json({
      status: 'success',
      data: {
        enrollmentType: enrollment.enrollmentType,
        overallProgress: totalLessons > 0
          ? (totalCompletedLessons / totalLessons) * 100
          : 0,
        moduleProgress,
        startedAt: enrollment.enrolledAt,
        lastAccessed: Math.max(
          ...enrollment.enrolledModules.map(em => em.lastAccessed)
        )
      }
    })
  } catch (error) {
    next(error)
  }
}

exports.getModuleProgress = async (req, res, next) => {
  try {
    const { courseId, moduleId } = req.params

    const module = await Module.findOne({
      _id: moduleId,
      course: courseId,
      isDeleted: false
    }).populate({
      path: 'lessons',
      match: { isDeleted: false },
      select: 'title order requireQuizPass',
      options: { sort: { order: 1 } },
      populate: {
        path: 'quiz',
        select: 'title type passingScore'
      }
    })

    if (!module) {
      return next(new AppError('Module not found', 404))
    }

    const enrollment = req.user.enrolledCourses?.find(
      e => e.course.toString() === courseId
    )

    if (!enrollment) {
      return next(new AppError('You are not enrolled in this course', 403))
    }

    const moduleEnrollment = enrollment.enrolledModules.find(
      em => em.module.toString() === moduleId
    )

    if (!moduleEnrollment && enrollment.enrollmentType !== 'full') {
      return next(new AppError('You do not have access to this module', 403))
    }

    const lessonProgress = module.lessons.map(lesson => ({
      lessonId: lesson._id,
      title: lesson.title,
      completed: moduleEnrollment?.completedLessons.includes(lesson._id),
      requireQuizPass: lesson.requireQuizPass,
      quiz: lesson.quiz ? {
        quizId: lesson.quiz._id,
        title: lesson.quiz.title,
        type: lesson.quiz.type,
        completed: moduleEnrollment?.completedQuizzes.includes(lesson.quiz._id),
        passingScore: lesson.quiz.passingScore
      } : null
    }))

    res.status(200).json({
      status: 'success',
      data: {
        moduleId: module._id,
        title: module.title,
        order: module.order,
        progress: {
          completedLessons: moduleEnrollment?.completedLessons.length || 0,
          totalLessons: module.lessons.length,
          completedQuizzes: moduleEnrollment?.completedQuizzes.length || 0,
          lastAccessed: moduleEnrollment?.lastAccessed
        },
        lessons: lessonProgress
      }
    })
  } catch (error) {
    next(error)
  }
}

// Add to course.controller.js

const enrollmentSchema = Joi.object({
  discountCode: Joi.string().trim(),
  redirectUrl: Joi.string().uri().required()
}).options({ abortEarly: false })

exports.enrollInCourse = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { error, value } = enrollmentSchema.validate(req.body)
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

    // Check if user is already enrolled
    const isEnrolled = await User.findOne({
      _id: req.user._id,
      'enrolledCourses.course': course._id,
      'enrolledCourses.enrollmentType': 'full'
    }).session(session)

    if (isEnrolled) {
      await session.abortTransaction()
      return next(new AppError('You are already enrolled in this course', 400))
    }

    // Calculate price with discount if code provided
    const { discountedAmount, discount } = await calculateDiscountedAmount(
      course.price,
      value.discountCode,
      course._id
    )

    // Generate transaction ID
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

exports.enrollInModule = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { error, value } = enrollmentSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map(detail => ({
          field: detail.context.key,
          message: detail.message
        }))
      })
    }

    const [course, module] = await Promise.all([
      Course.findOne({
        _id: req.params.courseId,
        isDeleted: false
      }).session(session),
      Module.findOne({
        _id: req.params.moduleId,
        course: req.params.courseId,
        isDeleted: false
      }).session(session)
    ])

    if (!course || !module) {
      await session.abortTransaction()
      return next(new AppError('Course or module not found', 404))
    }

    // Check if user is already enrolled in course or module
    const enrollment = await User.findOne({
      _id: req.user._id,
      'enrolledCourses.course': course._id
    }).session(session)

    if (enrollment?.enrolledCourses[0].enrollmentType === 'full') {
      await session.abortTransaction()
      return next(new AppError('You already have full access to this course', 400))
    }

    if (enrollment?.enrolledCourses[0].enrolledModules.some(
      em => em.module.toString() === module._id.toString()
    )) {
      await session.abortTransaction()
      return next(new AppError('You are already enrolled in this module', 400))
    }

    // Calculate price with discount if code provided
    const { discountedAmount, discount } = await calculateDiscountedAmount(
      course.modulePrice,
      value.discountCode,
      course._id,
      module._id
    )

    // Generate transaction ID
    const transactionId = crypto.randomBytes(16).toString('hex')

    // Create payment record
    const payment = await Payment.create([{
      user: req.user._id,
      course: course._id,
      purchaseType: 'module',
      modules: [module._id],
      amount: course.modulePrice,
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
      product_name: `${course.title} - ${module.title}`,
      product_category: 'Course Module',
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

exports.getEnrollmentStatus = async (req, res, next) => {
  try {
    const course = await Course.findOne({
      _id: req.params.courseId,
      isDeleted: false
    })
    .populate({
      path: 'modules',
      match: { isDeleted: false },
      select: 'title order prerequisites'
    })

    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    const enrollment = await User.findOne(
      {
        _id: req.user._id,
        'enrolledCourses.course': course._id
      },
      { 'enrolledCourses.$': 1 }
    )

    if (!enrollment) {
      return res.status(200).json({
        status: 'success',
        data: {
          isEnrolled: false,
          coursePrice: course.price,
          modulePrice: course.modulePrice
        }
      })
    }

    const enrolledCourse = enrollment.enrolledCourses[0]
    const moduleEnrollments = course.modules.map(module => ({
      moduleId: module._id,
      title: module.title,
      order: module.order,
      isEnrolled: enrolledCourse.enrollmentType === 'full' ||
        enrolledCourse.enrolledModules.some(em => 
          em.module.toString() === module._id.toString()
        ),
      price: course.modulePrice,
      prerequisites: module.prerequisites
    }))

    res.status(200).json({
      status: 'success',
      data: {
        isEnrolled: true,
        enrollmentType: enrolledCourse.enrollmentType,
        enrolledAt: enrolledCourse.enrolledAt,
        modules: moduleEnrollments
      }
    })
  } catch (error) {
    next(error)
  }
}

// Helper function to check prerequisites
async function checkPrerequisites(prerequisites, enrollment) {
  for (const prereqId of prerequisites) {
    const moduleEnrollment = enrollment.enrolledModules.find(
      em => em.module.toString() === prereqId.toString()
    )
    
    if (!moduleEnrollment) return false

    const prerequisite = await Module.findById(prereqId)
    const totalLessons = await Lesson.countDocuments({
      module: prereqId,
      isDeleted: false
    })

    const completionPercentage = (moduleEnrollment.completedLessons.length / totalLessons) * 100
    
    if (completionPercentage < (prerequisite.dependencies?.[0]?.requiredCompletion || 100)) {
      return false
    }
  }
  
  return true
}

