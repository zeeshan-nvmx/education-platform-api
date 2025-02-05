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
      message: 'Course created successfully',
      data: populatedCourse
    })
  } catch (error) {
    await cleanupInstructorImages(uploadedImageKeys)
    next(error)
  }
}

exports.getPublicCoursesList = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search;
    const category = req.query.category;
    const sortBy = req.query.sortBy || 'createdAt';
    const order = req.query.order || 'desc';

    // Build query
    const query = { isDeleted: false };

    if (category) {
      query.category = category;
    }

    if (search) {
      query.$text = { $search: search };
    }

    // Get total count for pagination
    const totalCourses = await Course.countDocuments(query);

    // Fetch courses with populated data
    const courses = await Course.find(query)
      .select('title description category thumbnail price modulePrice rating totalStudents featured createdAt')
      .populate({
        path: 'creator',
        select: 'firstName lastName'
      })
      .populate({
        path: 'modules',
        match: { isDeleted: false },
        select: 'title description order',
        options: { sort: { order: 1 } },
        populate: {
          path: 'lessons',
          match: { isDeleted: false },
          select: 'title description order duration requireQuizPass',
          options: { sort: { order: 1 } }
        }
      })
      .sort({ [sortBy]: order === 'desc' ? -1 : 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Transform the data to include only necessary information
    const transformedCourses = courses.map(course => ({
      _id: course._id,
      title: course.title,
      description: course.description,
      category: course.category,
      thumbnail: course.thumbnail,
      price: course.price,
      modulePrice: course.modulePrice,
      rating: course.rating,
      totalStudents: course.totalStudents,
      featured: course.featured,
      createdAt: course.createdAt,
      creator: {
        name: `${course.creator.firstName} ${course.creator.lastName}`
      },
      modules: course.modules.map(module => ({
        _id: module._id,
        title: module.title,
        description: module.description,
        order: module.order,
        totalLessons: module.lessons?.length || 0,
        lessons: module.lessons.map(lesson => ({
          _id: lesson._id,
          title: lesson.title,
          description: lesson.description,
          order: lesson.order,
          duration: lesson.duration,
          hasQuiz: lesson.requireQuizPass
        }))
      })),
      statistics: {
        totalModules: course.modules.length,
        totalLessons: course.modules.reduce((acc, module) => acc + (module.lessons?.length || 0), 0),
        totalDuration: course.modules.reduce((acc, module) => 
          acc + module.lessons.reduce((sum, lesson) => sum + (lesson.duration || 0), 0), 0)
      }
    }));

    // Calculate total pages
    const totalPages = Math.ceil(totalCourses / limit);

    res.status(200).json({
      status: 'success',
      message: 'Courses fetched successfully',
      data: {
        courses: transformedCourses,
        pagination: {
          currentPage: page,
          totalPages,
          totalCourses,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

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
      message: 'Courses fetched successfully',
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
        message: 'Course fetched successfully',
        data: limitedCourse
      })
    }

    res.status(200).json({
      message: 'Course fetched successfully',
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
      message: 'Course updated successfully',
      data: updatedCourse
    })
  } catch (error) {
    await cleanupInstructorImages(newUploadedImageKeys)
    next(error)
  }
}

// exports.deleteCourse = async (req, res, next) => {
//   const session = await mongoose.startSession()
//   session.startTransaction()

//   try {
//     const course = await Course.findById(req.params.courseId).session(session)
//     if (!course) {
//       await session.abortTransaction()
//       return next(new AppError('Course not found', 404))
//     }

//     const activeEnrollments = await User.countDocuments({
//       'enrolledCourses.course': course._id
//     }).session(session)

//     if (activeEnrollments > 0) {
//       course.isDeleted = true
//       await course.save({ session })

//       await Promise.all([
//         Module.updateMany({ course: course._id }, { isDeleted: true }, { session }),
//         Lesson.updateMany(
//           { module: { $in: await Module.find({ course: course._id }).distinct('_id') } },
//           { isDeleted: true },
//           { session }
//         )
//       ])
//     } else {
//       const imageKeys = [
//         course.thumbnailKey,
//         ...course.instructors
//           .filter(inst => inst.imageKey)
//           .map(inst => inst.imageKey)
//       ].filter(Boolean)

//       await cleanupInstructorImages(imageKeys)
//       await Course.deleteOne({ _id: course._id }).session(session)

//       const modules = await Module.find({ course: course._id })
//       await Promise.all([
//         Module.deleteMany({ course: course._id }).session(session),
//         Lesson.deleteMany({
//           module: { $in: modules.map(module => module._id) }
//         }).session(session)
//       ])
//     }

//     await session.commitTransaction()

//     res.status(200).json({
//       message: 'Course deleted successfully'
//     })
//   } catch (error) {
//     await session.abortTransaction()
//     next(error)
//   } finally {
//     session.endSession()
//   }
// }

exports.deleteCourse = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    // Find the course including deleted ones
    const course = await Course.findOne({ _id: req.params.courseId }).session(session)
    if (!course) {
      await session.abortTransaction()
      session.endSession()
      return next(new AppError('Course not found', 404))
    }

    // Check for active enrollments
    const activeEnrollments = await User.countDocuments({
      'enrolledCourses.course': course._id,
    }).session(session)

    if (activeEnrollments > 0) {
      // Soft delete course, modules, and lessons
      course.isDeleted = true
      await course.save({ session })

      // Get module IDs first
      const moduleIds = await Module.find({ course: course._id }).distinct('_id')

      await Promise.all([
        Module.updateMany({ course: course._id }, { isDeleted: true }, { session }),
        Lesson.updateMany({ module: { $in: moduleIds } }, { isDeleted: true }, { session }),
      ])
    } else {
      // Prepare instructor images for deletion
      const imageKeys = [course.thumbnailKey, ...course.instructors.filter((inst) => inst.imageKey).map((inst) => inst.imageKey)].filter(Boolean)

      // Cleanup instructor images safely
      try {
        await cleanupInstructorImages(imageKeys)
      } catch (cleanupError) {
        console.error('Failed to clean up instructor images:', cleanupError)
      }

      // Get module IDs before deleting
      const moduleIds = await Module.find({ course: course._id }).distinct('_id')

      await Promise.all([
        course.deleteOne({ session }),
        Module.deleteMany({ course: course._id }).session(session),
        Lesson.deleteMany({ module: { $in: moduleIds } }).session(session),
      ])
    }

    await session.commitTransaction()
    res.status(200).json({ message: 'Course deleted successfully' })
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
      message: 'Featured courses fetched successfully',
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
      message: 'Courses fetched successfully',
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
    const course = await Course.findById(req.params.courseId).populate({
      path: 'modules',
      match: { isDeleted: false },
      select: 'title description order prerequisites isAccessible dependencies',
      options: { sort: { order: 1 } },
    })

    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    const enrollment = req.user.enrolledCourses?.find((e) => e.course.toString() === course._id.toString())

    if (!enrollment) {
      return next(new AppError('You are not enrolled in this course', 403))
    }

    const moduleProgress = await Promise.all(
      course.modules.map(async (module) => {
        const moduleObj = module.toObject()

        // Check if user has full course access or is enrolled in this specific module
        const isFullAccess = enrollment.enrollmentType === 'full'
        const isModuleEnrolled = enrollment.enrolledModules?.some((em) => em.module.toString() === module._id.toString())
        moduleObj.isEnrolled = isFullAccess || isModuleEnrolled

        if (moduleObj.isEnrolled) {
          // Get module-specific progress
          const progress = await Progress.findOne({
            user: req.user._id,
            course: req.params.courseId,
            module: module._id,
          })

          if (progress) {
            moduleObj.progress = {
              overall: progress.progress,
              completedLessons: progress.completedLessons,
              completedQuizzes: progress.completedQuizzes,
              lastAccessed: progress.lastAccessed,
            }
          }

          // Check prerequisites if they exist
          if (module.prerequisites?.length > 0) {
            moduleObj.prerequisitesMet = await checkPrerequisites(module.prerequisites, req.user._id, req.params.courseId)
          }
        }

        // Add enrollment type for clarity
        moduleObj.enrollmentType = isFullAccess ? 'full' : isModuleEnrolled ? 'module' : null

        return moduleObj
      })
    )

    res.status(200).json({
      message: 'Course modules fetched successfully',
      data: moduleProgress,
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
        message: 'User has full access to this course',
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
        message: 'Module not found',
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
          message: 'User does not meet prerequisites for this module',
          data: {
            hasAccess: false,
            reason: 'prerequisites_not_met'
          }
        })
      }
    }

    res.status(200).json({
      message: "User has access to this module",
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
      message: 'Course progress fetched successfully',
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
      message: 'Module progress fetched successfully',
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
