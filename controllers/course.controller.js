const Joi = require('joi')
const mongoose = require('mongoose')
const { Course, Module, User, Progress, Lesson, Quiz, QuizAttempt, LessonProgress, VideoProgress, AssetProgress } = require('../models') // Import all necessary models
const { AppError } = require('../utils/errors')
const { uploadToS3, deleteFromS3 } = require('../utils/s3')
const sanitizeHtml = require('sanitize-html')
const CloudflareService = require('../utils/cloudflare')

// const instructorSchema = Joi.object({
//   name: Joi.string().required().trim(),
//   description: Joi.string().trim(),
//   designation: Joi.string().trim(),
//   expertise: Joi.array().items(Joi.string().trim()),
//   socialLinks: Joi.object({
//     linkedin: Joi.string().allow('', null).optional(),
//     twitter: Joi.string().allow('', null).optional(),
//     website: Joi.string().allow('', null).optional(),
//   }).optional(),
//   bio: Joi.string().trim(),
//   achievements: Joi.array().items(Joi.string()),
// }).options({ stripUnknown: true })

// const courseSchema = Joi.object({
//   title: Joi.string().trim(),
//   description: Joi.string().trim(),
//   longDescription: Joi.string().trim(),
//   category: Joi.string().trim(),
//   price: Joi.number().min(0),
//   featured: Joi.boolean(),
//   instructors: Joi.array().min(1).items(instructorSchema),
// }).options({ abortEarly: false })

const instructorSchema = Joi.object({
  name: Joi.string().required().trim(),
  description: Joi.string().trim(),
  designation: Joi.string().trim(),
  expertise: Joi.array().items(Joi.string().trim()),
  socialLinks: Joi.object({
    linkedin: Joi.string().allow('', null).optional(),
    twitter: Joi.string().allow('', null).optional(),
    website: Joi.string().allow('', null).optional(),
  }).optional(),
  bio: Joi.string().trim(),
  achievements: Joi.array().items(Joi.string()),
}).options({ stripUnknown: true })

const courseSchema = Joi.object({
  title: Joi.string().trim(),
  description: Joi.string().trim(),
  longDescription: Joi.string().trim(),
  category: Joi.string().trim(),
  price: Joi.number().min(0),
  featured: Joi.boolean(),
  instructors: Joi.array().min(1).items(instructorSchema),
}).options({ abortEarly: false })

const querySchema = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
  category: Joi.string(),
  featured: Joi.string(),
  search: Joi.string(),
  minPrice: Joi.number().min(0),
  maxPrice: Joi.number().min(Joi.ref('minPrice')),
  sortBy: Joi.string().valid('createdAt', 'price', 'rating', 'totalStudents'),
  order: Joi.string().valid('asc', 'desc'),
})

async function handleInstructorImages(instructors, instructorImages) {
  const processedInstructors = await Promise.all(
    instructors.map(async (instructor, index) => {
      const instructorImage = instructorImages?.[index]
      if (instructorImage) {
        const key = `instructor-images/${Date.now()}-${index}-${instructorImage.originalname}`
        const imageUrl = await uploadToS3(instructorImage, key)
        return { ...instructor, image: imageUrl, imageKey: key }
      }
      return instructor
    })
  )
  return processedInstructors
}

async function cleanupInstructorImages(imageKeys) {
  await Promise.all(imageKeys.map((key) => deleteFromS3(key).catch(console.error)))
}

async function checkQuizRequirements(userId, lessonId) {
  try {
    const lesson = await Lesson.findById(lessonId).populate('quiz')
    if (!lesson || !lesson.quiz) return true // No quiz = no requirements to check

    // Get user role to check if they're admin/moderator/subAdmin
    const user = await User.findById(userId).select('+role')
    const isAdmin = user && ['admin', 'subAdmin', 'moderator'].includes(user.role)

    // Admins bypass all requirements
    if (isAdmin) return true

    // Get user's time spent on lesson
    const timeSpentRecord = await LessonProgress.findOne({
      user: userId,
      lesson: lessonId,
    })

    // Check minimum time requirement
    if (lesson.quizSettings?.minimumTimeRequired > 0) {
      const timeSpent = timeSpentRecord?.timeSpent || 0
      if (timeSpent < lesson.quizSettings.minimumTimeRequired * 60) {
        // Convert minutes to seconds
        return false
      }
    }

    // Check for in-progress attempts and handle expired ones
    const inProgressAttempts = await QuizAttempt.find({
      quiz: lesson.quiz._id,
      user: userId,
      status: 'inProgress',
    })

    // If there are in-progress attempts, check if they've expired
    for (const attempt of inProgressAttempts) {
      const timeLimit = lesson.quiz.quizTime * 60 * 1000 // Convert to milliseconds
      const timeSinceStart = new Date() - attempt.startTime

      if (timeSinceStart <= timeLimit) {
        // Still valid attempt within time window - user can't take a new quiz
        return false
      }

      // If we're here, the attempt has expired but is still marked as inProgress
      // We'll mark it as submitted with zero score (same logic as in startQuiz)
      // Don't await this - we're just triggering the update but not waiting
      // This avoids performance issues in the getLesson endpoint
      QuizAttempt.findByIdAndUpdate(attempt._id, {
        status: 'submitted',
        submitTime: new Date(attempt.startTime.getTime() + timeLimit),
        score: 0,
        percentage: 0,
        passed: false,
      }).exec()

      // Continue checking other requirements - this attempt is now considered expired
    }

    // Check content viewing requirement for 'after' setting
    if (lesson.quizSettings?.showQuizAt === 'after') {
      // Check video progress if video exists
      if (lesson.videoUrl) {
        const videoProgress = await VideoProgress.findOne({
          user: userId,
          lesson: lessonId,
        })

        if (!videoProgress?.completed) {
          return false
        }
      }

      // Check required asset downloads
      const requiredAssets = lesson.completionRequirements?.downloadAssets?.filter((asset) => asset.required) || []

      if (requiredAssets.length > 0) {
        const assetDownloads = await AssetProgress.find({
          user: userId,
          lesson: lessonId,
          asset: { $in: requiredAssets.map((a) => a.assetId) },
        })

        if (assetDownloads.length < requiredAssets.length) {
          return false
        }
      }
    }

    // Check if max attempts reached
    const attemptCount = await QuizAttempt.countDocuments({
      quiz: lesson.quiz._id,
      user: userId,
      status: { $ne: 'inProgress' }, // Only count completed/submitted/graded attempts
    })

    if (attemptCount >= lesson.quiz.maxAttempts) {
      return false
    }

    return true
  } catch (error) {
    console.error('Error checking quiz requirements:', error)
    return false
  }
}

async function validateQuizCompletion(userId, lessonId) {
  try {
    const lesson = await Lesson.findById(lessonId).populate('quiz')
    if (!lesson || !lesson.quiz) return true // No quiz, so requirements are met

    const attempts = await QuizAttempt.find({
      quiz: lesson.quiz._id,
      user: userId,
      status: 'graded', // Only check graded attempts
    }).lean() // .lean() is good for performance here

    if (!attempts.length) return false // No graded attempts

    // Check if ANY attempt passed
    const hasPassedAttempt = attempts.some((attempt) => attempt.passed)

    return hasPassedAttempt
  } catch (error) {
    console.error('Error validating quiz completion:', error)
    return false // Fail gracefully
  }
}

// exports.createCourse = async (req, res, next) => {
//   let uploadedImageKeys = []

//   try {
//     const courseData = JSON.parse(req.body.courseData)
//     const { error, value } = courseSchema.validate(courseData)

//     if (error) {
//       return res.status(400).json({
//         status: 'error',
//         errors: error.details.map((detail) => ({
//           field: detail.context.key,
//           message: detail.message,
//         })),
//       })
//     }

//     const existingCourse = await Course.findOne({ title: value.title })
//     if (existingCourse) {
//       return next(new AppError('A course with this title already exists', 400))
//     }

//     let thumbnailUrl = null
//     let thumbnailKey = null
//     if (req.files?.thumbnail?.[0]) {
//       thumbnailKey = `course-thumbnails/${Date.now()}-${req.files.thumbnail[0].originalname}`
//       thumbnailUrl = await uploadToS3(req.files.thumbnail[0], thumbnailKey)
//       uploadedImageKeys.push(thumbnailKey)
//     }

//     const instructorsWithImages = await handleInstructorImages(value.instructors, req.files?.instructorImages)
//     uploadedImageKeys = uploadedImageKeys.concat(instructorsWithImages.filter((inst) => inst.imageKey).map((inst) => inst.imageKey))

//     value.description = sanitizeHtml(value.description, {
//       allowedTags: ['b', 'i', 'em', 'strong', 'p', 'br'],
//       allowedAttributes: {},
//     })

//     const course = await Course.create({
//       ...value,
//       thumbnail: thumbnailUrl,
//       thumbnailKey,
//       instructors: instructorsWithImages,
//       creator: req.user._id,
//     })

//     const populatedCourse = await Course.findById(course._id).populate('creator', 'firstName lastName email')

//     res.status(201).json({
//       message: 'Course created successfully',
//       data: populatedCourse,
//     })
//   } catch (error) {
//     await cleanupInstructorImages(uploadedImageKeys)
//     next(error)
//   }
// }

exports.createCourse = async (req, res, next) => {
  let uploadedImageKeys = []

  try {
    const courseData = JSON.parse(req.body.courseData)

    // Filter out null, undefined, or empty instructors before validation
    if (courseData.instructors && Array.isArray(courseData.instructors)) {
      courseData.instructors = courseData.instructors.filter(
        (instructor) => instructor && typeof instructor === 'object' && Object.keys(instructor).length > 0 && instructor.name
      )
    }

    // Check if we have at least one valid instructor
    if (!courseData.instructors || courseData.instructors.length === 0) {
      return res.status(400).json({
        status: 'error',
        errors: [
          {
            field: 'instructors',
            message: 'At least one valid instructor is required',
          },
        ],
      })
    }

    const { error, value } = courseSchema.validate(courseData)

    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
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

    const instructorsWithImages = await handleInstructorImages(value.instructors, req.files?.instructorImages)
    uploadedImageKeys = uploadedImageKeys.concat(instructorsWithImages.filter((inst) => inst.imageKey).map((inst) => inst.imageKey))

    value.description = sanitizeHtml(value.description, {
      allowedTags: ['b', 'i', 'em', 'strong', 'p', 'br'],
      allowedAttributes: {},
    })

    const course = await Course.create({
      ...value,
      thumbnail: thumbnailUrl,
      thumbnailKey,
      instructors: instructorsWithImages,
      creator: req.user._id,
    })

    const populatedCourse = await Course.findById(course._id).populate('creator', 'firstName lastName email')

    res.status(201).json({
      message: 'Course created successfully',
      data: populatedCourse,
    })
  } catch (error) {
    await cleanupInstructorImages(uploadedImageKeys)
    next(error)
  }
}

exports.getPublicCoursesList = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1
    const limit = parseInt(req.query.limit) || 10
    const query = {} 

    if (req.query.category) query.category = req.query.category
    if (req.query.featured) query.featured = req.query.featured === 'true'
    if (req.query.search) {
      query.$or = [{ title: new RegExp(req.query.search, 'i') }, { description: new RegExp(req.query.search, 'i') }]
    }

    const totalCourses = await Course.countDocuments(query)

    // Conditional population based on authentication
    let coursesQuery = Course.find(query)
      .select('title description category thumbnail price rating totalStudents featured createdAt creator modules trailerUrl trailerThumbnail trailerCloudflareVideoId')
      .populate({
        path: 'modules',
        select: 'title description order price lessons',
        match: {},
        populate: {
          path: 'lessons',
          select: 'title description order duration requireQuizPass',
          match: {},
          options: { sort: { order: 1 } },
        },
      })
      .sort({ [req.query.sortBy || 'createdAt']: req.query.order === 'asc' ? 1 : -1 })
      .skip((page - 1) * limit)
      .limit(limit)

    if (req.user && req.user._id) {
      // If user is authenticated, populate the creator
      coursesQuery = coursesQuery.populate({
        path: 'creator',
        select: 'firstName lastName',
      })
    }
    

    const courses = await coursesQuery.lean()

    const transformedCourses = courses.map((course) => {
      let creatorInfo = { name: 'Unknown Creator' } 
      if (course.creator) {
        // Check if creator exists (populated)
        creatorInfo = {
          name: `${course.creator.firstName} ${course.creator.lastName}`,
        }
      }

      return {
        _id: course._id,
        title: course.title,
        description: course.description,
        category: course.category,
        thumbnail: course.thumbnail,
        trailerUrl: course.trailerUrl || '',
        trailerThumbnail: course.trailerThumbnail || '',
        trailerCloudflareVideoId: course.trailerCloudflareVideoId || '',
        price: course.price,
        rating: course.rating,
        totalStudents: course.totalStudents,
        featured: course.featured,
        createdAt: course.createdAt,
        creator: creatorInfo,
        modules: course.modules.map((module) => ({
          _id: module._id,
          title: module.title,
          description: module.description,
          order: module.order,
          price: module.price,
          totalLessons: module.lessons.length,
          lessons: module.lessons.map((lesson) => ({
            _id: lesson._id,
            title: lesson.title,
            description: lesson.description,
            order: lesson.order,
            duration: lesson.duration,
            hasQuiz: lesson.requireQuizPass,
          })),
        })),
        statistics: {
          totalModules: course.modules.length,
          totalLessons: course.modules.reduce((acc, module) => acc + module.lessons.length, 0),
          totalDuration: course.modules.reduce((acc, module) => acc + module.lessons.reduce((sum, lesson) => sum + (lesson.duration || 0), 0), 0),
        },
      }
    })

    const totalPages = Math.ceil(totalCourses / limit)

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
          hasPrevPage: page > 1,
        },
      },
    })
  } catch (error) {
    console.error('getPublicCoursesList error:', error)
    next(error)
  }
}

exports.getAllCourses = async (req, res, next) => {
  try {
    const { error, value } = querySchema.validate(req.query)
    if (error) {
      return next(new AppError(error.details[0].message, 400))
    }

    const { page = 1, limit = 10, category, featured, search, minPrice, maxPrice, sortBy = 'createdAt', order = 'desc' } = value

    const query = {} 

    if (category) {
      query.category = category
    }

    if (featured) {
      query.featured = featured === 'true'
    }

    if (search) {
      const searchRegex = new RegExp(search, 'i')
      query.$or = [{ title: searchRegex }, { description: searchRegex }]
    }

    if (!isNaN(minPrice) || !isNaN(maxPrice)) {
      query.price = {}
      if (!isNaN(minPrice)) query.price.$gte = parseFloat(minPrice)
      if (!isNaN(maxPrice)) query.price.$lte = parseFloat(maxPrice)
    }

    const validPage = Math.max(1, parseInt(page))
    const validLimit = Math.min(100, Math.max(1, parseInt(limit)))
    const skip = (validPage - 1) * validLimit

    const allowedSortFields = ['createdAt', 'price', 'rating', 'totalStudents']
    const validSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'createdAt'
    const sortDirection = order === 'asc' ? 1 : -1
    const sortOptions = { [validSortBy]: sortDirection }

    const [totalCourses, courses] = await Promise.all([
      Course.countDocuments(query),
      Course.find(query)
        .select('-__v') 
        .populate('creator', 'firstName lastName email')
        .sort(sortOptions)
        .skip(skip)
        .limit(validLimit)
        .lean()
        .exec(),
    ])

    const totalPages = Math.ceil(totalCourses / validLimit)

    res.status(200).json({
      message: 'Courses fetched successfully',
      data: {
        courses: courses.map((course) => ({
          ...course,
          trailerUrl: course.trailerUrl || '',
          trailerThumbnail: course.trailerThumbnail || '',
          trailerCloudflareVideoId: course.trailerCloudflareVideoId || '',
          creator: {
            name: `${course.creator?.firstName || ''} ${course.creator?.lastName || ''}`.trim(),
            email: course.creator?.email,
          },
        })),
        pagination: {
          currentPage: validPage,
          totalPages,
          totalCourses,
          hasNextPage: validPage < totalPages,
          hasPrevPage: validPage > 1,
        },
      },
    })
  } catch (error) {
    console.error('getAllCourses error:', error)
    next(error)
  }
}

// exports.getCourse = async (req, res, next) => {
//   try {
//     if (!mongoose.Types.ObjectId.isValid(req.params.courseId)) {
//       return next(new AppError('Invalid course ID', 400))
//     }

//     const courseId = req.params.courseId
//     console.log(`Getting course details for course ID: ${courseId}`)

//     // Check if the user is authenticated
//     const userId = req.user?._id
//     console.log(`User ID from request: ${userId}`)

//     const course = await Course.findOne({
//       _id: courseId,
//     })
//       .populate('creator', 'firstName lastName email')
//       .populate({
//         path: 'modules',
//         select: 'title description order price prerequisites isAccessible dependencies',
//         options: { sort: { order: 1 } },
//         populate: {
//           path: 'lessons',
//           select: 'title description order videoUrl duration requireQuizPass completionRequirements quizSettings assets',
//           options: { sort: { order: 1 } },
//           populate: {
//             path: 'quiz',
//             select: 'title type passingScore duration maxAttempts',
//           },
//         },
//       })
//       .lean()

//     if (!course) {
//       return next(new AppError('Course not found', 404))
//     }

//     console.log(`Found course: ${course.title}`)

//     // Check for authenticated user and fetch enrollment data
//     let authenticatedUser = null
//     let enrollment = null

//     if (userId) {
//       authenticatedUser = await User.findById(userId)
//       console.log(`Found authenticated user: ${authenticatedUser?.firstName} ${authenticatedUser?.lastName}`)
//       console.log(`User enrolled courses count: ${authenticatedUser?.enrolledCourses?.length || 0}`)

//       if (authenticatedUser?.enrolledCourses?.length) {
//         enrollment = authenticatedUser.enrolledCourses.find((ec) => ec.course && ec.course.toString() === courseId)

//         if (enrollment) {
//           console.log(`User has enrollment for this course. Type: ${enrollment.enrollmentType}`)
//           console.log(`Enrolled modules count: ${enrollment.enrolledModules?.length || 0}`)

//           if (enrollment.enrolledModules?.length) {
//             enrollment.enrolledModules.forEach((em, index) => {
//               console.log(`Module ${index + 1}: ${em.module}`)
//             })
//           }
//         } else {
//           console.log('User does not have enrollment for this course')
//         }
//       }
//     }

//     // Determine roles (admin/creator)
//     const isCreator = authenticatedUser && course.creator && course.creator._id.toString() === authenticatedUser._id.toString()
//     const isAdmin = authenticatedUser?.role === 'admin'
//     console.log(`User roles - Creator: ${isCreator}, Admin: ${isAdmin}`)

//     //  Build the Course Data 
//     const courseDetails = {
//       _id: course._id,
//       title: course.title || '',
//       description: course.description || '',
//       longDescription: course.longDescription || '',
//       category: course.category || '',
//       price: course.price || 0,
//       thumbnail: course.thumbnail || '',
//       trailerUrl: course.trailerUrl || '',
//       trailerThumbnail: course.trailerThumbnail || '',
//       trailerCloudflareVideoId: course.trailerCloudflareVideoId || '',
//       rating: course.rating || 0,
//       totalStudents: course.totalStudents || 0,
//       featured: course.featured || false,
//       creator: course.creator
//         ? {
//             name: `${course.creator.firstName || ''} ${course.creator.lastName || ''}`.trim(),
//             email: isAdmin || isCreator ? course.creator.email : undefined, // Only show email to admin/creator
//           }
//         : { name: 'Unknown Creator' },
//       instructors: Array.isArray(course.instructors)
//         ? course.instructors.map((instructor) => ({
//             _id: instructor._id || '',
//             name: instructor.name || '',
//             description: instructor.description || '',
//             designation: instructor.designation || '',
//             image: instructor.image || '',
//             expertise: Array.isArray(instructor.expertise) ? instructor.expertise : [],
//             bio: instructor.bio || '',
//             socialLinks: instructor.socialLinks || {},
//           }))
//         : [],
//     }

//     // --- Fetch Overall Course Progress ---
//     let courseProgress = {
//       completedModules: 0,
//       totalModules: 0,
//       completedLessons: 0,
//       totalLessons: 0,
//       completedQuizzes: 0,
//       totalQuizzes: 0, // Added to track overall quiz completion
//       overallProgress: 0,
//     }

//     if (enrollment && userId) {
//       const allModuleProgress = await Progress.find({
//         user: userId,
//         course: courseId,
//       }).lean()

//       // Aggregate progress data from all modules
//       allModuleProgress.forEach((moduleProgress) => {
//         courseProgress.completedLessons += moduleProgress.completedLessons.length
//         courseProgress.completedQuizzes += moduleProgress.completedQuizzes.length
//       })
//     }

//     // --- Determine Access Level ---
//     const hasFullAccess = isCreator || isAdmin || (enrollment && enrollment.enrollmentType === 'full')
//     console.log(`User has full access: ${hasFullAccess}`)

//     const enrolledModuleIds = new Set()
//     if (enrollment && Array.isArray(enrollment.enrolledModules)) {
//       enrollment.enrolledModules.forEach((em) => {
//         if (em && em.module) {
//           enrolledModuleIds.add(em.module.toString())
//         }
//       })
//     }
//     console.log(`Enrolled module IDs: ${Array.from(enrolledModuleIds).join(', ')}`)

//     // --- Process Modules ---
//     const modules = Array.isArray(course.modules) ? course.modules : []
//     courseDetails.modules = await Promise.all(
//       modules.map(async (module) => {
//         if (!module) return null

//         const moduleId = module._id.toString()
//         const hasModuleAccess = hasFullAccess || enrolledModuleIds.has(moduleId)
//         console.log(`Module ${moduleId} (${module.title}) - User has access: ${hasModuleAccess}`)

//         const moduleData = {
//           _id: module._id,
//           title: module.title || '',
//           description: module.description || '',
//           order: module.order || 0,
//           price: module.price || 0,
//           totalLessons: Array.isArray(module.lessons) ? module.lessons.length : 0,
//           isAccessible: !!module.isAccessible,
//           prerequisites: Array.isArray(module.prerequisites) ? module.prerequisites : [],
//           progress: {
//             // Initialize module progress
//             completedLessons: 0,
//             completedQuizzes: 0,
//             progress: 0,
//             lastAccessed: null,
//           },
//         }

//         // --- Fetch Module-Specific Progress ---
//         if (enrollment && userId) {
//           let moduleProgress = await Progress.findOne({
//             user: userId,
//             course: courseId,
//             module: moduleId,
//           }).lean()

//           // FIX: If no Progress document, check enrolledModules for completed lessons
//           if (!moduleProgress) {
//             const enrolledModule = enrollment.enrolledModules.find((em) => em.module.toString() === moduleId)
//             if (enrolledModule) {
//               moduleData.progress = {
//                 completedLessons: enrolledModule.completedLessons.length,
//                 completedQuizzes: enrolledModule.completedQuizzes.length,
//                 progress: 0, // Will be calculated later
//                 lastAccessed: enrolledModule.lastAccessed,
//               }
//               // Calculate progress based on completed lessons
//               if (moduleData.totalLessons > 0) {
//                 moduleData.progress.progress = (moduleData.progress.completedLessons / moduleData.totalLessons) * 100
//               }
//             }
//           } else {
//             moduleData.progress = {
//               completedLessons: moduleProgress.completedLessons.length,
//               completedQuizzes: moduleProgress.completedQuizzes.length,
//               progress: moduleProgress.progress,
//               lastAccessed: moduleProgress.lastAccessed,
//             }
//           }

//           //Update course progress
//           courseProgress.totalModules += 1
//           if (moduleData.progress.progress === 100) {
//             courseProgress.completedModules += 1
//           }
//         }

//         // --- Process Lessons within the Module ---
//         if (hasModuleAccess) {
//           const lessons = Array.isArray(module.lessons) ? module.lessons : []
//           moduleData.lessons = await Promise.all(
//             lessons.map(async (lesson) => {
//               if (!lesson) return null

//               const lessonData = {
//                 _id: lesson._id,
//                 title: lesson.title || '',
//                 description: lesson.description || '',
//                 order: lesson.order || 0,
//                 duration: lesson.duration || 0,
//                 requireQuizPass: !!lesson.requireQuizPass,
//                 hasVideo: !!lesson.videoUrl,
//                 totalAssets: Array.isArray(lesson.assets) ? lesson.assets.length : 0,
//                 completionRequirements: {
//                   watchVideo: !!lesson.completionRequirements?.watchVideo,
//                   hasRequiredAssets:
//                     Array.isArray(lesson.completionRequirements?.downloadAssets) && lesson.completionRequirements.downloadAssets.some((asset) => asset && asset.required),
//                   minimumTimeSpent: lesson.completionRequirements?.minimumTimeSpent || 0,
//                 },
//                 progress: {
//                   // Initialize lesson progress
//                   completed: false,
//                   //quizCompleted: false, // Removed as requested
//                 },
//               }
//               courseProgress.totalLessons += 1

//               if (lesson.quiz) {
//                 lessonData.quiz = {
//                   _id: lesson.quiz._id,
//                   title: lesson.quiz.title || '',
//                   type: lesson.quiz.type || '',
//                   passingScore: lesson.quiz.passingScore || 0,
//                   duration: lesson.quiz.duration || 0,
//                   maxAttempts: lesson.quiz.maxAttempts || 0,
//                   settings: {
//                     required: !!lesson.quizSettings?.required,
//                     minimumPassingScore: lesson.quizSettings?.minimumPassingScore || 70,
//                     blockProgress: !!lesson.quizSettings?.blockProgress,
//                     showQuizAt: lesson.quizSettings?.showQuizAt || 'after',
//                     minimumTimeRequired: lesson.quizSettings?.minimumTimeRequired || 0,
//                   },
//                   progress: {
//                     // Initialize quiz progress
//                     completed: false, //  <--- THIS WAS MISSING, now restored
//                     canTake: false,
//                     remainingAttempts: 0,
//                   },
//                 }
//                 courseProgress.totalQuizzes += 1
//               }

//               // --- Fetch Lesson-Specific Progress ---
//               if (enrollment && userId) {
//                 // Fetch moduleProgress *INSIDE* the lesson loop
//                 const moduleProgress = await Progress.findOne({
//                   user: userId,
//                   course: courseId,
//                   module: moduleId,
//                 }).lean()

//                 const isLessonCompleted =
//                   moduleProgress && moduleProgress.completedLessons.some((completedLessonId) => completedLessonId.toString() === lesson._id.toString())
//                 lessonData.progress.completed = isLessonCompleted

//                 if (lesson.quiz) {
//                   const quizAttempts = await QuizAttempt.find({
//                     quiz: lesson.quiz._id,
//                     user: userId,
//                   })
//                     .sort('-startTime')
//                     .lean()

//                   const isQuizCompleted =
//                     moduleProgress && moduleProgress.completedQuizzes.some((completedQuizId) => completedQuizId.toString() === lesson.quiz._id.toString())

//                   // FIX: Set completed status here!
//                   lessonData.quiz.progress.completed = isQuizCompleted // <---  RESTORE THIS LINE
//                   lessonData.quiz.progress.canTake = await checkQuizRequirements(userId, lesson._id)
//                   lessonData.quiz.progress.remainingAttempts = Math.max(lesson.quiz.maxAttempts - quizAttempts.length, 0)
//                 }
//               }

//               return lessonData
//             })
//           )
//         } else {
//           // If no module access, still show basic lesson info (no progress)
//           const lessons = Array.isArray(module.lessons) ? module.lessons : []
//           moduleData.lessons = lessons.map((lesson) => {
//             if (!lesson) return null
//             return {
//               _id: lesson._id,
//               title: lesson.title || '',
//               description: lesson.description || '',
//               order: lesson.order || 0,
//               duration: lesson.duration || 0,
//               hasQuiz: !!lesson.quiz,
//               hasVideo: !!lesson.videoUrl,
//               totalAssets: Array.isArray(lesson.assets) ? lesson.assets.length : 0,
//             }
//           })
//         }

//         return moduleData
//       })
//     )

//     // --- Add Enrollment Data ---
//     if (enrollment) {
//       console.log('Including enrollment data in response')

//       const formattedEnrolledModules = []

//       if (Array.isArray(enrollment.enrolledModules)) {
//         for (const em of enrollment.enrolledModules) {
//           if (!em || !em.module) continue

//           formattedEnrolledModules.push({
//             module: em.module,
//             enrolledAt: em.enrolledAt || enrollment.enrolledAt || new Date(),
//             completedLessons: Array.isArray(em.completedLessons) ? em.completedLessons : [],
//             completedQuizzes: Array.isArray(em.completedQuizzes) ? em.completedQuizzes : [],
//             lastAccessed: em.lastAccessed || enrollment.enrolledAt || new Date(),
//           })
//         }
//       }

//       console.log(`Formatted enrolled modules count: ${formattedEnrolledModules.length}`)

//       courseDetails.enrollment = {
//         type: enrollment.enrollmentType,
//         enrolledAt: enrollment.enrolledAt,
//         enrolledModules: formattedEnrolledModules,
//       }
//     } else {
//       console.log('No enrollment data to include')
//     }

//     // --- Calculate Overall Course Progress ---
//     if (enrollment && userId) {
//       if (courseProgress.totalLessons > 0) {
//         courseProgress.overallProgress = (courseProgress.completedLessons / courseProgress.totalLessons) * 100
//       }
//     }
//     courseDetails.progress = courseProgress

//     // --- Course Statistics ---
//     courseDetails.statistics = {
//       totalModules: courseDetails.modules.length,
//       totalLessons: courseDetails.modules.reduce((acc, module) => acc + (Array.isArray(module.lessons) ? module.lessons.length : 0), 0),
//       totalDuration: courseDetails.modules.reduce(
//         (acc, module) => acc + (Array.isArray(module.lessons) ? module.lessons.reduce((sum, lesson) => sum + (lesson?.duration || 0), 0) : 0),
//         0
//       ),
//       totalQuizzes: courseDetails.modules.reduce(
//         (acc, module) => acc + (Array.isArray(module.lessons) ? module.lessons.reduce((sum, lesson) => sum + (lesson?.quiz ? 1 : 0), 0) : 0),
//         0
//       ),
//     }

//     const finalResponse = {
//       message: 'Course fetched successfully',
//       data: courseDetails,
//     }

//     // Log the enrollment part of the response
//     console.log('Enrollment in response:', JSON.stringify(finalResponse.data.enrollment))
//     console.log('course progress in response:', JSON.stringify(finalResponse.data.progress))

//     res.status(200).json(finalResponse)
//   } catch (error) {
//     console.error('Error in getCourse:', error)
//     next(error)
//   }
// }

exports.getCourse = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.courseId)) {
      return next(new AppError('Invalid course ID', 400))
    }

    const courseId = req.params.courseId
    console.log(`Getting course details for course ID: ${courseId}`)

    // Check if the user is authenticated
    const userId = req.user?._id
    console.log(`User ID from request: ${userId}`)

    const course = await Course.findOne({
      _id: courseId,
    })
      .populate('creator', 'firstName lastName email')
      .populate({
        path: 'modules',
        select: 'title description order price prerequisites isAccessible dependencies',
        options: { sort: { order: 1 } },
        populate: {
          path: 'lessons',
          select: 'title description order videoUrl duration requireQuizPass completionRequirements quizSettings assets',
          options: { sort: { order: 1 } },
          populate: {
            path: 'quiz',
            select: 'title type passingScore duration maxAttempts',
          },
        },
      })
      .lean()

    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    console.log(`Found course: ${course.title}`)

    // Check for authenticated user and fetch enrollment data
    let authenticatedUser = null
    let enrollment = null

    if (userId) {
      authenticatedUser = await User.findById(userId)
      console.log(`Found authenticated user: ${authenticatedUser?.firstName} ${authenticatedUser?.lastName}`)
      console.log(`User enrolled courses count: ${authenticatedUser?.enrolledCourses?.length || 0}`)

      if (authenticatedUser?.enrolledCourses?.length) {
        enrollment = authenticatedUser.enrolledCourses.find((ec) => ec.course && ec.course.toString() === courseId)

        if (enrollment) {
          console.log(`User has enrollment for this course. Type: ${enrollment.enrollmentType}`)
          console.log(`Enrolled modules count: ${enrollment.enrolledModules?.length || 0}`)

          if (enrollment.enrolledModules?.length) {
            enrollment.enrolledModules.forEach((em, index) => {
              console.log(`Module ${index + 1}: ${em.module}`)
            })
          }
        } else {
          console.log('User does not have enrollment for this course')
        }
      }
    }

    // Determine roles (admin/creator)
    const isCreator = authenticatedUser && course.creator && course.creator._id.toString() === authenticatedUser._id.toString()
    const isAdmin = authenticatedUser?.role === 'admin'
    console.log(`User roles - Creator: ${isCreator}, Admin: ${isAdmin}`)

    //  Build the Course Data
    const courseDetails = {
      _id: course._id,
      title: course.title || '',
      description: course.description || '',
      longDescription: course.longDescription || '',
      category: course.category || '',
      price: course.price || 0,
      thumbnail: course.thumbnail || '',
      trailerUrl: course.trailerUrl || '',
      trailerThumbnail: course.trailerThumbnail || '',
      trailerCloudflareVideoId: course.trailerCloudflareVideoId || '',
      rating: course.rating || 0,
      totalStudents: course.totalStudents || 0,
      featured: course.featured || false,
      // Include the newly added fields
      courseOverview: course.courseOverview || '',
      learning: course.learning || '',
      courseReq: course.courseReq || '',
      courseBenefit: course.courseBenefit || '',
      whyChoose: course.whyChoose || '',
      knowledgePartImage1: course.knowledgePartImage1 || null,
      knowledgePartImage2: course.knowledgePartImage2 || null,
      knowledgePartImage3: course.knowledgePartImage3 || null,
      creator: course.creator
        ? {
            name: `${course.creator.firstName || ''} ${course.creator.lastName || ''}`.trim(),
            email: isAdmin || isCreator ? course.creator.email : undefined, // Only show email to admin/creator
          }
        : { name: 'Unknown Creator' },
      instructors: Array.isArray(course.instructors)
        ? course.instructors.map((instructor) => ({
            _id: instructor._id || '',
            name: instructor.name || '',
            description: instructor.description || '',
            designation: instructor.designation || '',
            image: instructor.image || '',
            expertise: Array.isArray(instructor.expertise) ? instructor.expertise : [],
            bio: instructor.bio || '',
            socialLinks: instructor.socialLinks || {},
          }))
        : [],
    }

    // --- Fetch Overall Course Progress ---
    let courseProgress = {
      completedModules: 0,
      totalModules: 0,
      completedLessons: 0,
      totalLessons: 0,
      completedQuizzes: 0,
      totalQuizzes: 0, // Added to track overall quiz completion
      overallProgress: 0,
    }

    if (enrollment && userId) {
      const allModuleProgress = await Progress.find({
        user: userId,
        course: courseId,
      }).lean()

      // Aggregate progress data from all modules
      allModuleProgress.forEach((moduleProgress) => {
        courseProgress.completedLessons += moduleProgress.completedLessons.length
        courseProgress.completedQuizzes += moduleProgress.completedQuizzes.length
      })
    }

    // --- Determine Access Level ---
    const hasFullAccess = isCreator || isAdmin || (enrollment && enrollment.enrollmentType === 'full')
    console.log(`User has full access: ${hasFullAccess}`)

    const enrolledModuleIds = new Set()
    if (enrollment && Array.isArray(enrollment.enrolledModules)) {
      enrollment.enrolledModules.forEach((em) => {
        if (em && em.module) {
          enrolledModuleIds.add(em.module.toString())
        }
      })
    }
    console.log(`Enrolled module IDs: ${Array.from(enrolledModuleIds).join(', ')}`)

    // --- Process Modules ---
    const modules = Array.isArray(course.modules) ? course.modules : []
    courseDetails.modules = await Promise.all(
      modules.map(async (module) => {
        if (!module) return null

        const moduleId = module._id.toString()
        const hasModuleAccess = hasFullAccess || enrolledModuleIds.has(moduleId)
        console.log(`Module ${moduleId} (${module.title}) - User has access: ${hasModuleAccess}`)

        const moduleData = {
          _id: module._id,
          title: module.title || '',
          description: module.description || '',
          order: module.order || 0,
          price: module.price || 0,
          totalLessons: Array.isArray(module.lessons) ? module.lessons.length : 0,
          isAccessible: !!module.isAccessible,
          prerequisites: Array.isArray(module.prerequisites) ? module.prerequisites : [],
          progress: {
            // Initialize module progress
            completedLessons: 0,
            completedQuizzes: 0,
            progress: 0,
            lastAccessed: null,
          },
        }

        // --- Fetch Module-Specific Progress ---
        if (enrollment && userId) {
          let moduleProgress = await Progress.findOne({
            user: userId,
            course: courseId,
            module: moduleId,
          }).lean()

          // FIX: If no Progress document, check enrolledModules for completed lessons
          if (!moduleProgress) {
            const enrolledModule = enrollment.enrolledModules.find((em) => em.module.toString() === moduleId)
            if (enrolledModule) {
              moduleData.progress = {
                completedLessons: enrolledModule.completedLessons.length,
                completedQuizzes: enrolledModule.completedQuizzes.length,
                progress: 0, // Will be calculated later
                lastAccessed: enrolledModule.lastAccessed,
              }
              // Calculate progress based on completed lessons
              if (moduleData.totalLessons > 0) {
                moduleData.progress.progress = (moduleData.progress.completedLessons / moduleData.totalLessons) * 100
              }
            }
          } else {
            moduleData.progress = {
              completedLessons: moduleProgress.completedLessons.length,
              completedQuizzes: moduleProgress.completedQuizzes.length,
              progress: moduleProgress.progress,
              lastAccessed: moduleProgress.lastAccessed,
            }
          }

          //Update course progress
          courseProgress.totalModules += 1
          if (moduleData.progress.progress === 100) {
            courseProgress.completedModules += 1
          }
        }

        // --- Process Lessons within the Module ---
        if (hasModuleAccess) {
          const lessons = Array.isArray(module.lessons) ? module.lessons : []
          moduleData.lessons = await Promise.all(
            lessons.map(async (lesson) => {
              if (!lesson) return null

              const lessonData = {
                _id: lesson._id,
                title: lesson.title || '',
                description: lesson.description || '',
                order: lesson.order || 0,
                duration: lesson.duration || 0,
                requireQuizPass: !!lesson.requireQuizPass,
                hasVideo: !!lesson.videoUrl,
                totalAssets: Array.isArray(lesson.assets) ? lesson.assets.length : 0,
                completionRequirements: {
                  watchVideo: !!lesson.completionRequirements?.watchVideo,
                  hasRequiredAssets:
                    Array.isArray(lesson.completionRequirements?.downloadAssets) && lesson.completionRequirements.downloadAssets.some((asset) => asset && asset.required),
                  minimumTimeSpent: lesson.completionRequirements?.minimumTimeSpent || 0,
                },
                progress: {
                  // Initialize lesson progress
                  completed: false,
                  //quizCompleted: false, // Removed as requested
                },
              }
              courseProgress.totalLessons += 1

              if (lesson.quiz) {
                lessonData.quiz = {
                  _id: lesson.quiz._id,
                  title: lesson.quiz.title || '',
                  type: lesson.quiz.type || '',
                  passingScore: lesson.quiz.passingScore || 0,
                  duration: lesson.quiz.duration || 0,
                  maxAttempts: lesson.quiz.maxAttempts || 0,
                  settings: {
                    required: !!lesson.quizSettings?.required,
                    minimumPassingScore: lesson.quizSettings?.minimumPassingScore || 70,
                    blockProgress: !!lesson.quizSettings?.blockProgress,
                    showQuizAt: lesson.quizSettings?.showQuizAt || 'after',
                    minimumTimeRequired: lesson.quizSettings?.minimumTimeRequired || 0,
                  },
                  progress: {
                    // Initialize quiz progress
                    completed: false, //  <--- THIS WAS MISSING, now restored
                    canTake: false,
                    remainingAttempts: 0,
                  },
                }
                courseProgress.totalQuizzes += 1
              }

              // --- Fetch Lesson-Specific Progress ---
              if (enrollment && userId) {
                // Fetch moduleProgress *INSIDE* the lesson loop
                const moduleProgress = await Progress.findOne({
                  user: userId,
                  course: courseId,
                  module: moduleId,
                }).lean()

                const isLessonCompleted =
                  moduleProgress && moduleProgress.completedLessons.some((completedLessonId) => completedLessonId.toString() === lesson._id.toString())
                lessonData.progress.completed = isLessonCompleted

                if (lesson.quiz) {
                  const quizAttempts = await QuizAttempt.find({
                    quiz: lesson.quiz._id,
                    user: userId,
                  })
                    .sort('-startTime')
                    .lean()

                  const isQuizCompleted =
                    moduleProgress && moduleProgress.completedQuizzes.some((completedQuizId) => completedQuizId.toString() === lesson.quiz._id.toString())

                  // FIX: Set completed status here!
                  lessonData.quiz.progress.completed = isQuizCompleted // <---  RESTORE THIS LINE
                  lessonData.quiz.progress.canTake = await checkQuizRequirements(userId, lesson._id)
                  lessonData.quiz.progress.remainingAttempts = Math.max(lesson.quiz.maxAttempts - quizAttempts.length, 0)
                }
              }

              return lessonData
            })
          )
        } else {
          // If no module access, still show basic lesson info (no progress)
          const lessons = Array.isArray(module.lessons) ? module.lessons : []
          moduleData.lessons = lessons.map((lesson) => {
            if (!lesson) return null
            return {
              _id: lesson._id,
              title: lesson.title || '',
              description: lesson.description || '',
              order: lesson.order || 0,
              duration: lesson.duration || 0,
              hasQuiz: !!lesson.quiz,
              hasVideo: !!lesson.videoUrl,
              totalAssets: Array.isArray(lesson.assets) ? lesson.assets.length : 0,
            }
          })
        }

        return moduleData
      })
    )

    // --- Add Enrollment Data ---
    if (enrollment) {
      console.log('Including enrollment data in response')

      const formattedEnrolledModules = []

      if (Array.isArray(enrollment.enrolledModules)) {
        for (const em of enrollment.enrolledModules) {
          if (!em || !em.module) continue

          formattedEnrolledModules.push({
            module: em.module,
            enrolledAt: em.enrolledAt || enrollment.enrolledAt || new Date(),
            completedLessons: Array.isArray(em.completedLessons) ? em.completedLessons : [],
            completedQuizzes: Array.isArray(em.completedQuizzes) ? em.completedQuizzes : [],
            lastAccessed: em.lastAccessed || enrollment.enrolledAt || new Date(),
          })
        }
      }

      console.log(`Formatted enrolled modules count: ${formattedEnrolledModules.length}`)

      courseDetails.enrollment = {
        type: enrollment.enrollmentType,
        enrolledAt: enrollment.enrolledAt,
        enrolledModules: formattedEnrolledModules,
      }
    } else {
      console.log('No enrollment data to include')
    }

    // --- Calculate Overall Course Progress ---
    if (enrollment && userId) {
      if (courseProgress.totalLessons > 0) {
        courseProgress.overallProgress = (courseProgress.completedLessons / courseProgress.totalLessons) * 100
      }
    }
    courseDetails.progress = courseProgress

    // --- Course Statistics ---
    courseDetails.statistics = {
      totalModules: courseDetails.modules.length,
      totalLessons: courseDetails.modules.reduce((acc, module) => acc + (Array.isArray(module.lessons) ? module.lessons.length : 0), 0),
      totalDuration: courseDetails.modules.reduce(
        (acc, module) => acc + (Array.isArray(module.lessons) ? module.lessons.reduce((sum, lesson) => sum + (lesson?.duration || 0), 0) : 0),
        0
      ),
      totalQuizzes: courseDetails.modules.reduce(
        (acc, module) => acc + (Array.isArray(module.lessons) ? module.lessons.reduce((sum, lesson) => sum + (lesson?.quiz ? 1 : 0), 0) : 0),
        0
      ),
    }

    const finalResponse = {
      message: 'Course fetched successfully',
      data: courseDetails,
    }

    // Log the enrollment part of the response
    console.log('Enrollment in response:', JSON.stringify(finalResponse.data.enrollment))
    console.log('course progress in response:', JSON.stringify(finalResponse.data.progress))

    res.status(200).json(finalResponse)
  } catch (error) {
    console.error('Error in getCourse:', error)
    next(error)
  }
}

// exports.updateCourse = async (req, res, next) => {
//   let newUploadedImageKeys = []

//   try {
//     const courseData = JSON.parse(req.body.courseData || '{}')
//     const { error, value } = courseSchema.validate(courseData)

//     if (error) {
//       return res.status(400).json({
//         status: 'error',
//         errors: error.details.map((detail) => ({
//           field: detail.context.key,
//           message: detail.message,
//         })),
//       })
//     }

//     if (Object.keys(value).length === 0 && !req.files) {
//       return next(new AppError('No update data provided', 400))
//     }

//     const course = await Course.findById(req.params.courseId)
//     if (!course) {
//       return next(new AppError('Course not found', 404))
//     }

//     if (req.files?.thumbnail?.[0]) {
//       if (course.thumbnailKey) {
//         await deleteFromS3(course.thumbnailKey).catch(console.error)
//       }
//       const thumbnailKey = `course-thumbnails/${Date.now()}-${req.files.thumbnail[0].originalname}`
//       const thumbnailUrl = await uploadToS3(req.files.thumbnail[0], thumbnailKey)
//       value.thumbnail = thumbnailUrl
//       value.thumbnailKey = thumbnailKey
//       newUploadedImageKeys.push(thumbnailKey)
//     }

//     if (value.instructors) {
//       const oldInstructorImageKeys = course.instructors.filter((inst) => inst.imageKey).map((inst) => inst.imageKey)

//       const instructorsWithImages = await handleInstructorImages(value.instructors, req.files?.instructorImages)
//       newUploadedImageKeys = newUploadedImageKeys.concat(instructorsWithImages.filter((inst) => inst.imageKey).map((inst) => inst.imageKey))

//       value.instructors = instructorsWithImages
//       await cleanupInstructorImages(oldInstructorImageKeys)
//     }

//     if (value.description) {
//       value.description = sanitizeHtml(value.description, {
//         allowedTags: ['b', 'i', 'em', 'strong', 'p', 'br'],
//         allowedAttributes: {},
//       })
//     }

//     if (value.title && value.title !== course.title) {
//       const existingCourse = await Course.findOne({
//         title: value.title,
//         _id: { $ne: req.params.courseId },
//       })
//       if (existingCourse) {
//         await cleanupInstructorImages(newUploadedImageKeys)
//         return next(new AppError('A course with this title already exists', 400))
//       }
//     }

//     const updatedCourse = await Course.findByIdAndUpdate(req.params.courseId, { ...value }, { new: true, runValidators: true }).populate(
//       'creator',
//       'firstName lastName email'
//     )

//     res.status(200).json({
//       message: 'Course updated successfully',
//       data: updatedCourse,
//     })
//   } catch (error) {
//     await cleanupInstructorImages(newUploadedImageKeys)
//     next(error)
//   }
// }

exports.updateCourse = async (req, res, next) => {
  let newUploadedImageKeys = []

  try {
    const courseData = JSON.parse(req.body.courseData || '{}')

    // Default behavior is to append instructors, unless replaceInstructors is explicitly set to true
    const isReplaceOperation = courseData.replaceInstructors === true

    // Filter out null, undefined, or empty instructors before validation
    if (courseData.instructors && Array.isArray(courseData.instructors)) {
      courseData.instructors = courseData.instructors.filter(
        (instructor) => instructor && typeof instructor === 'object' && Object.keys(instructor).length > 0 && instructor.name
      )

      // If instructors array provided but empty after filtering, this is an error
      if (courseData.instructors.length === 0) {
        return res.status(400).json({
          status: 'error',
          errors: [
            {
              field: 'instructors',
              message: 'At least one valid instructor is required',
            },
          ],
        })
      }
    }

    const { error, value } = courseSchema.validate(courseData)

    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
    }

    if (Object.keys(value).length === 0 && !req.files) {
      return next(new AppError('No update data provided', 400))
    }

    const course = await Course.findById(req.params.courseId)
    if (!course) {
      return next(new AppError('Course not found', 404))
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
      // Get new instructors with images
      const instructorsWithImages = await handleInstructorImages(value.instructors, req.files?.instructorImages)
      newUploadedImageKeys = newUploadedImageKeys.concat(instructorsWithImages.filter((inst) => inst.imageKey).map((inst) => inst.imageKey))

      // Replace existing instructors (only if explicitly requested)
      if (isReplaceOperation) {
        const oldInstructorImageKeys = course.instructors.filter((inst) => inst.imageKey).map((inst) => inst.imageKey)
        value.instructors = instructorsWithImages
        await cleanupInstructorImages(oldInstructorImageKeys)
      }
      // Append new instructors to existing ones (default behavior)
      else {
        // Combine existing instructors with new ones
        value.instructors = [...course.instructors, ...instructorsWithImages]
      }
    }

    if (value.description) {
      value.description = sanitizeHtml(value.description, {
        allowedTags: ['b', 'i', 'em', 'strong', 'p', 'br'],
        allowedAttributes: {},
      })
    }

    if (value.title && value.title !== course.title) {
      const existingCourse = await Course.findOne({
        title: value.title,
        _id: { $ne: req.params.courseId },
      })
      if (existingCourse) {
        await cleanupInstructorImages(newUploadedImageKeys)
        return next(new AppError('A course with this title already exists', 400))
      }
    }

    const updatedCourse = await Course.findByIdAndUpdate(req.params.courseId, { ...value }, { new: true, runValidators: true }).populate(
      'creator',
      'firstName lastName email'
    )

    res.status(200).json({
      message: 'Course updated successfully',
      data: updatedCourse,
    })
  } catch (error) {
    await cleanupInstructorImages(newUploadedImageKeys)
    next(error)
  }
}

exports.updateInstructor = async (req, res, next) => {
  let newUploadedImageKeys = []

  try {
    const instructorData = JSON.parse(req.body.instructorData || '{}')

    // Validate instructorId is provided
    if (!instructorData.instructorId) {
      return res.status(400).json({
        status: 'error',
        message: 'instructorId is required to update an instructor',
      })
    }

    // Find the course
    const course = await Course.findById(req.params.courseId)
    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    // Find the instructor to update
    const instructorIndex = course.instructors.findIndex((instructor) => instructor._id.toString() === instructorData.instructorId)

    if (instructorIndex === -1) {
      return next(new AppError('Instructor not found in this course', 404))
    }

    // Get the existing instructor data
    const existingInstructor = course.instructors[instructorIndex]
    const existingData = existingInstructor.toObject ? existingInstructor.toObject() : { ...existingInstructor }

    // Create updated instructor data object
    const updatedInstructor = { ...existingData }

    // Update fields from request
    if (instructorData.instructor) {
      Object.keys(instructorData.instructor).forEach((key) => {
        updatedInstructor[key] = instructorData.instructor[key]
      })
    }

    // Handle instructor image if uploaded
    if (req.files?.instructorImage?.[0]) {
      // Try to delete old image if exists
      if (existingData.imageKey) {
        try {
          await deleteFromS3(existingData.imageKey)
        } catch (err) {
          console.error('Error deleting old instructor image:', err)
        }
      }

      // Create a guaranteed clean filename with no user input
      const timestamp = Date.now()
      const uniqueId = Math.random().toString(36).substring(2, 10)
      const fileType = req.files.instructorImage[0].mimetype.split('/')[1] || 'png'

      // Build a completely safe key
      const safeKey = `instructor-images/${timestamp}-${uniqueId}.${fileType}`

      // Upload with our safe key
      const imageUrl = await uploadToS3(req.files.instructorImage[0], safeKey)

      // Set both fields on the instructor
      updatedInstructor.image = imageUrl
      updatedInstructor.imageKey = safeKey
      newUploadedImageKeys.push(safeKey)
    }

    // Update the instructor in the course
    course.instructors[instructorIndex] = updatedInstructor

    // Ensure Mongoose detects the change
    course.markModified('instructors')

    // Save the updated course
    await course.save()

    res.status(200).json({
      message: 'Instructor updated successfully',
      data: course,
    })
  } catch (error) {
    // Clean up any newly uploaded images on error
    if (newUploadedImageKeys.length > 0) {
      await Promise.all(newUploadedImageKeys.map((key) => deleteFromS3(key)))
    }
    next(error)
  }
}

exports.uploadCourseTrailer = async (req, res, next) => {
  try {
    // Initial validations before any operations
    if (!req.file) {
      return next(new AppError('Please provide a video file', 400))
    }

    // Check file size
    const maxSize = 500 * 1024 * 1024 // 500MB in bytes for trailers (smaller than lessons)
    if (req.file.size > maxSize) {
      return next(new AppError('Video file too large. Maximum size is 500MB', 400))
    }

    // Check file type
    if (!req.file.mimetype.startsWith('video/')) {
      return next(new AppError('Please upload only video files', 400))
    }

    // Find the course without transaction
    const course = await Course.findOne({
      _id: req.params.courseId,
      isDeleted: { $ne: true },
    })

    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    // Store old video ID for cleanup
    const oldVideoId = course.trailerCloudflareVideoId

    // Upload new video to Cloudflare (outside transaction)
    let uploadResult
    try {
      uploadResult = await CloudflareService.uploadVideo(req.file)
    } catch (uploadError) {
      console.error('Error during trailer upload:', uploadError)
      return next(new AppError('Failed to upload trailer. Please try again.', 500))
    }

    // Now start MongoDB transaction for database updates
    const session = await mongoose.startSession()
    session.startTransaction()

    try {
      // Update course with only essential video details
      course.trailerUrl = uploadResult.videoDetails.playbackUrl
      course.trailerCloudflareVideoId = uploadResult.videoId
      course.trailerThumbnail = uploadResult.videoDetails.thumbnail

      await course.save({ session })
      await session.commitTransaction()

      // After successful transaction, delete old video if it exists
      if (oldVideoId) {
        try {
          await CloudflareService.deleteVideo(oldVideoId)
        } catch (error) {
          console.error('Error deleting old trailer video:', error)
          // Don't fail the request if old video deletion fails
        }
      }

      // Force garbage collection
      if (global.gc) {
        global.gc()
      }

      res.status(200).json({
        message: 'Course trailer uploaded successfully',
        data: {
          trailerUrl: course.trailerUrl,
          trailerThumbnail: course.trailerThumbnail,
          trailerCloudflareVideoId: course.trailerCloudflareVideoId,
        },
      })
    } catch (error) {
      // If database update fails, try to delete the newly uploaded video
      try {
        await CloudflareService.deleteVideo(uploadResult.videoId)
      } catch (deleteError) {
        console.error('Error deleting failed upload:', deleteError)
      }

      await session.abortTransaction()
      throw error
    } finally {
      session.endSession()
    }
  } catch (error) {
    console.error('Error in uploadCourseTrailer:', error)
    next(error)
  }
}

exports.deleteCourse = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const courseId = req.params.courseId
    const course = await Course.findById(courseId).session(session)

    if (!course) {
      await session.abortTransaction()
      session.endSession()
      return next(new AppError('Course not found', 404))
    }

    // Get module IDs *before* deleting
    const moduleIds = await Module.find({ course: courseId }).distinct('_id').session(session)

    // Cleanup Instructor Images
    const imageKeys = [course.thumbnailKey, ...course.instructors.filter((inst) => inst.imageKey).map((inst) => inst.imageKey)].filter(Boolean)

    try {
      await cleanupInstructorImages(imageKeys)
    } catch (cleanupError) {
      console.error('Failed to clean up images:', cleanupError)
      
    }

    // Delete Course and Related Documents
    await Promise.all([
      Course.deleteOne({ _id: courseId }).session(session),
      Module.deleteMany({ course: courseId }).session(session),
      Lesson.deleteMany({ module: { $in: moduleIds } }).session(session),
      Progress.deleteMany({ course: courseId }).session(session),
      Quiz.deleteMany({ lesson: { $in: await Lesson.find({ module: { $in: moduleIds } }).distinct('_id') } }).session(session), // Delete related quizzes
      QuizAttempt.deleteMany({
        quiz: { $in: await Quiz.find({ lesson: { $in: await Lesson.find({ module: { $in: moduleIds } }).distinct('_id') } }).distinct('_id') },
      }).session(session), // Delete related quiz attempts
      LessonProgress.deleteMany({ lesson: { $in: await Lesson.find({ module: { $in: moduleIds } }).distinct('_id') } }).session(session),
      VideoProgress.deleteMany({ lesson: { $in: await Lesson.find({ module: { $in: moduleIds } }).distinct('_id') } }).session(session),
      AssetProgress.deleteMany({ lesson: { $in: await Lesson.find({ module: { $in: moduleIds } }).distinct('_id') } }).session(session),

      // Remove Course from User Enrollments
      User.updateMany({ 'enrolledCourses.course': courseId }, { $pull: { enrolledCourses: { course: courseId } } }, { session }),
    ])

    await session.commitTransaction()
    res.status(200).json({ message: 'Course deleted successfully' })
  } catch (error) {
    await session.abortTransaction()
    console.error('Delete course error:', error)
    next(error)
  } finally {
    session.endSession()
  }
}

exports.deleteInstructor = async (req, res, next) => {
  try {
    const { courseId } = req.params
    const { instructorId } = req.body

    // Validate instructorId is provided
    if (!instructorId) {
      return res.status(400).json({
        status: 'error',
        message: 'instructorId is required to delete an instructor',
      })
    }

    // Find the course
    const course = await Course.findById(courseId)
    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    // Make sure there will be at least one instructor left after deletion
    if (course.instructors.length <= 1) {
      return next(new AppError('Cannot delete the last instructor. Course must have at least one instructor', 400))
    }

    // Find the instructor to delete
    const instructorIndex = course.instructors.findIndex((instructor) => instructor._id.toString() === instructorId)

    if (instructorIndex === -1) {
      return next(new AppError('Instructor not found in this course', 404))
    }

    // Store the instructor image key for cleanup if it exists
    const instructorImageKey = course.instructors[instructorIndex].imageKey

    // Remove the instructor from the array
    course.instructors.splice(instructorIndex, 1)

    // Save the updated course
    await course.save()

    // Clean up the instructor image from S3 if it exists
    if (instructorImageKey) {
      await deleteFromS3(instructorImageKey).catch(console.error)
    }

    res.status(200).json({
      status: 'success',
      message: 'Instructor deleted successfully',
    })
  } catch (error) {
    next(error)
  }
}

exports.getFeaturedCourses = async (req, res, next) => {
  try {
    const courses = await Course.find({ featured: true }) // No isDeleted
      .select('-__v')
      .populate('creator', 'firstName lastName')
      .sort('-rating')
      .limit(6)
      .lean()

    res.status(200).json({
      message: 'Featured courses fetched successfully',
      data: courses,
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
      Course.countDocuments({ category }), // No isDeleted
      Course.find({ category }) // No isDeleted
        .select('-__v')
        .populate('creator', 'firstName lastName')
        .sort('-createdAt')
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
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
          hasPrevPage: page > 1,
        },
      },
    })
  } catch (error) {
    next(error)
  }
}

exports.getCourseModules = async (req, res, next) => {
  try {
    const course = await Course.findById(req.params.courseId).populate({
      path: 'modules',
      select: 'title description order price prerequisites isAccessible dependencies rating',
      options: { sort: { order: 1 } },
    })

    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    // Handle unauthenticated users - maintain original response format with null values
    if (!req.user) {
      const modulesWithFormat = course.modules.map((module) => {
        const moduleObj = module.toObject()

        // Maintain the same structure as authenticated users for frontend compatibility
        return {
          ...moduleObj,
          isEnrolled: false,
          enrollmentType: null,
          progress: null,
          prerequisitesMet: null,
          reviewCount: 0, // Add this field for consistency
        }
      })

      return res.status(200).json({
        message: 'Course modules fetched successfully',
        data: modulesWithFormat,
      })
    }

    // For authenticated users, check enrollment
    const enrollment = req.user.enrolledCourses?.find((e) => e && e.course && e.course.toString() === course._id.toString())

    if (!enrollment) {
      return next(new AppError('You are not enrolled in this course', 403))
    }

    const moduleProgress = await Promise.all(
      course.modules.map(async (module) => {
        const moduleObj = module.toObject()

        const isFullAccess = enrollment.enrollmentType === 'full'
        const enrolledModules = enrollment.enrolledModules || []
        const isModuleEnrolled = enrolledModules.some((em) => em && em.module && em.module.toString() === module._id.toString())

        moduleObj.isEnrolled = isFullAccess || isModuleEnrolled

        if (moduleObj.isEnrolled) {
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

          if (module.prerequisites?.length > 0) {
            moduleObj.prerequisitesMet = await checkPrerequisites(module.prerequisites, req.user._id, req.params.courseId)
          }
        }

        moduleObj.enrollmentType = isFullAccess ? 'full' : isModuleEnrolled ? 'module' : null

        // Get review count for this module
        const reviewCount = await ModuleReview.countDocuments({
          module: module._id,
          isDeleted: false,
        })
        moduleObj.reviewCount = reviewCount

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

// exports.getCourseModules = async (req, res, next) => {
//   try {
//     const course = await Course.findById(req.params.courseId).populate({
//       path: 'modules',
//       select: 'title description order price prerequisites isAccessible dependencies', // No isDeleted
//       options: { sort: { order: 1 } },
//     })

//     if (!course) {
//       return next(new AppError('Course not found', 404))
//     }

//     const enrollment = req.user.enrolledCourses?.find((e) => e.course.toString() === course._id.toString())

//     if (!enrollment) {
//       return next(new AppError('You are not enrolled in this course', 403))
//     }

//     const moduleProgress = await Promise.all(
//       course.modules.map(async (module) => {
//         const moduleObj = module.toObject()

//         const isFullAccess = enrollment.enrollmentType === 'full'
//         const isModuleEnrolled = enrollment.enrolledModules?.some((em) => em.module.toString() === module._id.toString())
//         moduleObj.isEnrolled = isFullAccess || isModuleEnrolled

//         if (moduleObj.isEnrolled) {
//           const progress = await Progress.findOne({
//             user: req.user._id,
//             course: req.params.courseId,
//             module: module._id,
//           })

//           if (progress) {
//             moduleObj.progress = {
//               overall: progress.progress,
//               completedLessons: progress.completedLessons,
//               completedQuizzes: progress.completedQuizzes,
//               lastAccessed: progress.lastAccessed,
//             }
//           }

//           if (module.prerequisites?.length > 0) {
//             moduleObj.prerequisitesMet = await checkPrerequisites(module.prerequisites, req.user._id, req.params.courseId)
//           }
//         }
//         moduleObj.enrollmentType = isFullAccess ? 'full' : isModuleEnrolled ? 'module' : null
//         return moduleObj
//       })
//     )

//     res.status(200).json({
//       message: 'Course modules fetched successfully',
//       data: moduleProgress,
//     })
//   } catch (error) {
//     next(error)
//   }
// }

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
      
    })

    if (!module) {
      return next(new AppError('Module not found', 404))
    }
    const enrollment = req.user.enrolledCourses?.find((e) => e.course.toString() === courseId)

    if (!enrollment) {
      return res.status(200).json({
        status: 'success',
        data: {
          hasAccess: false,
          reason: 'not_enrolled',
        },
      })
    }

    if (enrollment.enrollmentType === 'full') {
      return res.status(200).json({
        message: 'User has full access to this course',
        data: {
          hasAccess: true,
          enrollmentType: 'full',
        },
      })
    }
    const moduleEnrollment = enrollment.enrolledModules.find((em) => em.module.toString() === moduleId)

    if (!moduleEnrollment) {
      return res.status(200).json({
        message: 'Module not found',
        data: {
          hasAccess: false,
          reason: 'module_not_purchased',
        },
      })
    }
    if (module.prerequisites?.length > 0) {
      const prerequisitesMet = await checkPrerequisites(module.prerequisites, req.user._id, courseId) // Corrected arguments
      if (!prerequisitesMet) {
        return res.status(200).json({
          message: 'User does not meet prerequisites for this module',
          data: {
            hasAccess: false,
            reason: 'prerequisites_not_met',
          },
        })
      }
    }

    res.status(200).json({
      message: 'User has access to this module',
      data: {
        hasAccess: true,
        enrollmentType: 'module',
        progress: {
          completedLessons: moduleEnrollment.completedLessons,
          completedQuizzes: moduleEnrollment.completedQuizzes,
          lastAccessed: moduleEnrollment.lastAccessed,
        },
      },
    })
  } catch (error) {
    next(error)
  }
}


exports.getCourseProgress = async (req, res, next) => {
  try {
    const { courseId } = req.params

    const course = await Course.findById(courseId).populate({
      path: 'modules',
      select: 'title order', 
      options: { sort: { order: 1 } },
      populate: {
        path: 'lessons',
        select: '_id', 
      },
    })

    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    const enrollment = req.user.enrolledCourses?.find((e) => e.course.toString() === courseId)

    if (!enrollment) {
      return next(new AppError('You are not enrolled in this course', 403))
    }

    const totalLessons = course.modules.reduce((total, module) => total + module.lessons.length, 0)

    const moduleProgress = course.modules.map((module) => {
      const enrolledModule = enrollment.enrolledModules.find((em) => em.module.toString() === module._id.toString())

      const completedLessonsCount = enrolledModule?.completedLessons.length || 0
      const totalModuleLessons = module.lessons.length

      return {
        moduleId: module._id,
        title: module.title,
        completedLessons: completedLessonsCount,
        totalLessons: totalModuleLessons,
        progress: totalModuleLessons > 0 ? (completedLessonsCount / totalModuleLessons) * 100 : 0,
      }
    })

    const totalCompletedLessons = moduleProgress.reduce((total, module) => total + module.completedLessons, 0)

    res.status(200).json({
      message: 'Course progress fetched successfully',
      data: {
        enrollmentType: enrollment.enrollmentType,
        overallProgress: totalLessons > 0 ? (totalCompletedLessons / totalLessons) * 100 : 0,
        moduleProgress,
        startedAt: enrollment.enrolledAt,
        lastAccessed: Math.max(...enrollment.enrolledModules.map((em) => em.lastAccessed)),
      },
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
      // No isDeleted needed
    }).populate({
      path: 'lessons',
      select: 'title order requireQuizPass', // No isDeleted needed
      options: { sort: { order: 1 } },
      populate: {
        path: 'quiz',
        select: 'title type passingScore',
      },
    })

    if (!module) {
      return next(new AppError('Module not found', 404))
    }

    const enrollment = req.user.enrolledCourses?.find((e) => e.course.toString() === courseId)

    if (!enrollment) {
      return next(new AppError('You are not enrolled in this course', 403))
    }

    const moduleEnrollment = enrollment.enrolledModules.find((em) => em.module.toString() === moduleId)

    if (!moduleEnrollment && enrollment.enrollmentType !== 'full') {
      return next(new AppError('You do not have access to this module', 403))
    }

    const lessonProgress = module.lessons.map((lesson) => ({
      lessonId: lesson._id,
      title: lesson.title,
      completed: moduleEnrollment?.completedLessons.includes(lesson._id),
      requireQuizPass: lesson.requireQuizPass,
      quiz: lesson.quiz
        ? {
            quizId: lesson.quiz._id,
            title: lesson.quiz.title,
            type: lesson.quiz.type,
            completed: moduleEnrollment?.completedQuizzes.includes(lesson.quiz._id),
            passingScore: lesson.quiz.passingScore,
          }
        : null,
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
          lastAccessed: moduleEnrollment?.lastAccessed,
        },
        lessons: lessonProgress,
      },
    })
  } catch (error) {
    next(error)
  }
}

exports.updateCourseDetails = async (req, res, next) => {
  try {
    console.log('Request body:', req.body)

    if (!mongoose.Types.ObjectId.isValid(req.params.courseId)) {
      return next(new AppError('Invalid course ID', 400))
    }

    const courseId = req.params.courseId
    console.log('Course ID:', courseId)

    // Validate that the course exists
    const course = await Course.findById(courseId)
    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    // Parse the courseInfo object from form data
    let courseInfo
    try {
      console.log('courseInfo from request:', req.body.courseInfo)
      courseInfo = JSON.parse(req.body.courseInfo || '{}')
      console.log('Parsed courseInfo:', courseInfo)
    } catch (err) {
      console.error('Error parsing courseInfo:', err)
      return next(new AppError('Invalid courseInfo format. Expected valid JSON.', 400))
    }

    const { courseOverview, learning, courseReq, courseBenefit, whyChoose } = courseInfo

    console.log('Extracted fields:', {
      courseOverview,
      learning,
      courseReq,
      courseBenefit,
      whyChoose,
    })

    // Create update data object
    const updateData = {}

    // Process each field - always update if provided (including empty strings)
    if (courseOverview !== undefined) {
      updateData.courseOverview = courseOverview === '' ? '' : sanitizeHtml(courseOverview)
    }

    if (learning !== undefined) {
      updateData.learning = learning === '' ? '' : sanitizeHtml(learning)
    }

    if (courseReq !== undefined) {
      updateData.courseReq = courseReq === '' ? '' : sanitizeHtml(courseReq)
    }

    if (courseBenefit !== undefined) {
      updateData.courseBenefit = courseBenefit === '' ? '' : sanitizeHtml(courseBenefit)
    }

    if (whyChoose !== undefined) {
      updateData.whyChoose = whyChoose === '' ? '' : sanitizeHtml(whyChoose)
    }

    console.log('Update data:', updateData)

    // If no fields were provided, return an error
    if (Object.keys(updateData).length === 0) {
      return next(new AppError('No fields provided for update', 400))
    }

    // Update the course with the new data
    const updatedCourse = await Course.findByIdAndUpdate(courseId, updateData, { new: true, runValidators: true })

    res.status(200).json({
      message: 'Course details updated successfully',
      data: updatedCourse,
    })
  } catch (error) {
    console.error('Error in updateCourseDetails:', error)
    next(error)
  }
}

// exports.uploadKnowledgeImages = async (req, res, next) => {
//   try {
//     console.log('Starting upload function with files:', Object.keys(req.files))

//     if (!mongoose.Types.ObjectId.isValid(req.params.courseId)) {
//       return next(new AppError('Invalid course ID', 400))
//     }

//     const courseId = req.params.courseId
//     console.log('Course ID:', courseId)

//     // Validate that the course exists
//     const course = await Course.findById(courseId)
//     console.log('Found course:', course ? course._id : 'No course found')

//     if (!course) {
//       return next(new AppError('Course not found', 404))
//     }

//     // Track the uploaded image keys for potential cleanup
//     const uploadedImageKeys = []
//     const updateData = {}
//     console.log('Processing knowledgePartImage1...')

//     // Process knowledgePartImage1
//     if (req.files?.knowledgePartImage1?.[0]) {
//       console.log('Found knowledgePartImage1 file:', req.files.knowledgePartImage1[0].originalname)

//       try {
//         // Delete old image if exists
//         if (course.knowledgePartImageKey1) {
//           console.log('Deleting old image with key:', course.knowledgePartImageKey1)
//           await deleteFromS3(course.knowledgePartImageKey1)
//         }

//         // Create a guaranteed clean filename with no user input
//         const timestamp = Date.now()
//         const uniqueId = Math.random().toString(36).substring(2, 10)
//         const fileType = req.files.knowledgePartImage1[0].mimetype.split('/')[1] || 'png'

//         // Build a completely safe key
//         const imageKey = `course-knowledge/${courseId}/part1-${timestamp}-${uniqueId}.${fileType}`
//         console.log('Generated new image key:', imageKey)

//         const imageUrl = await uploadToS3(req.files.knowledgePartImage1[0], imageKey)
//         console.log('Uploaded to S3, received URL:', imageUrl)

//         uploadedImageKeys.push(imageKey)
//         updateData.knowledgePartImage1 = imageUrl
//         updateData.knowledgePartImageKey1 = imageKey
//         console.log('Added image1 to updateData')
//       } catch (uploadError) {
//         console.error('Error processing knowledgePartImage1:', uploadError)
//         return next(new AppError(`Error uploading image 1: ${uploadError.message}`, 500))
//       }
//     }

//     console.log('Processing knowledgePartImage2...')
//     // Process knowledgePartImage2
//     if (req.files?.knowledgePartImage2?.[0]) {
//       console.log('Found knowledgePartImage2 file:', req.files.knowledgePartImage2[0].originalname)

//       try {
//         // Delete old image if exists
//         if (course.knowledgePartImageKey2) {
//           console.log('Deleting old image with key:', course.knowledgePartImageKey2)
//           await deleteFromS3(course.knowledgePartImageKey2)
//         }

//         // Create a guaranteed clean filename with no user input
//         const timestamp = Date.now()
//         const uniqueId = Math.random().toString(36).substring(2, 10)
//         const fileType = req.files.knowledgePartImage2[0].mimetype.split('/')[1] || 'png'

//         // Build a completely safe key
//         const imageKey = `course-knowledge/${courseId}/part2-${timestamp}-${uniqueId}.${fileType}`
//         console.log('Generated new image key:', imageKey)

//         const imageUrl = await uploadToS3(req.files.knowledgePartImage2[0], imageKey)
//         console.log('Uploaded to S3, received URL:', imageUrl)

//         uploadedImageKeys.push(imageKey)
//         updateData.knowledgePartImage2 = imageUrl
//         updateData.knowledgePartImageKey2 = imageKey
//         console.log('Added image2 to updateData')
//       } catch (uploadError) {
//         console.error('Error processing knowledgePartImage2:', uploadError)
//         return next(new AppError(`Error uploading image 2: ${uploadError.message}`, 500))
//       }
//     }

//     // If no files uploaded, return error
//     console.log('Update data length:', Object.keys(updateData).length)
//     if (Object.keys(updateData).length === 0) {
//       console.log('No update data was created, despite having files in request')
//       return next(new AppError('No images provided for upload', 400))
//     }

//     console.log('Updating course with data:', updateData)
//     // Update the course with the new image URLs
//     const updatedCourse = await Course.findByIdAndUpdate(courseId, updateData, { new: true, runValidators: true })

//     console.log('Course updated successfully')
//     res.status(200).json({
//       message: 'Knowledge part images uploaded successfully',
//       data: updatedCourse,
//     })
//   } catch (error) {
//     console.error('Error in uploadKnowledgeImages:', error)
//     // Attempt to clean up any uploaded images if operation fails
//     if (uploadedImageKeys.length > 0) {
//       for (const key of uploadedImageKeys) {
//         try {
//           await deleteFromS3(key)
//         } catch (cleanupError) {
//           console.error('Error cleaning up uploaded image:', cleanupError)
//         }
//       }
//     }
//     next(error)
//   }
// }

// exports.deleteKnowledgeImage = async (req, res, next) => {
//   try {
//     if (!mongoose.Types.ObjectId.isValid(req.params.courseId)) {
//       return next(new AppError('Invalid course ID', 400))
//     }

//     const courseId = req.params.courseId
//     const { part } = req.params
    
//     if (part !== '1' && part !== '2') {
//       return next(new AppError('Invalid part number. Must be 1 or 2', 400))
//     }

//     // Validate that the course exists
//     const course = await Course.findById(courseId)
//     if (!course) {
//       return next(new AppError('Course not found', 404))
//     }

//     const updateData = {}
    
//     // Delete the image based on the part number
//     if (part === '1') {
//       if (course.knowledgePartImageKey1) {
//         await deleteFromS3(course.knowledgePartImageKey1)
//         updateData.knowledgePartImage1 = null
//         updateData.knowledgePartImageKey1 = null
//       } else {
//         return next(new AppError('No image found for knowledge part 1', 404))
//       }
//     } else { // part === '2'
//       if (course.knowledgePartImageKey2) {
//         await deleteFromS3(course.knowledgePartImageKey2)
//         updateData.knowledgePartImage2 = null
//         updateData.knowledgePartImageKey2 = null
//       } else {
//         return next(new AppError('No image found for knowledge part 2', 404))
//       }
//     }

//     // Update the course to remove the image references
//     const updatedCourse = await Course.findByIdAndUpdate(
//       courseId,
//       updateData,
//       { new: true, runValidators: true }
//     )

//     res.status(200).json({
//       message: `Knowledge part ${part} image deleted successfully`,
//       data: updatedCourse
//     })
//   } catch (error) {
//     console.error('Error in deleteKnowledgeImage:', error)
//     next(error)
//   }
// }

exports.uploadKnowledgeImages = async (req, res, next) => {
  try {
    console.log('Starting upload function with files:', Object.keys(req.files))

    if (!mongoose.Types.ObjectId.isValid(req.params.courseId)) {
      return next(new AppError('Invalid course ID', 400))
    }

    const courseId = req.params.courseId
    console.log('Course ID:', courseId)

    // Validate that the course exists
    const course = await Course.findById(courseId)
    console.log('Found course:', course ? course._id : 'No course found')

    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    // Track the uploaded image keys for potential cleanup
    const uploadedImageKeys = []
    const updateData = {}

    // Process knowledgePartImage1
    console.log('Processing knowledgePartImage1...')
    if (req.files?.knowledgePartImage1?.[0]) {
      console.log('Found knowledgePartImage1 file:', req.files.knowledgePartImage1[0].originalname)

      try {
        // Delete old image if exists
        if (course.knowledgePartImageKey1) {
          console.log('Deleting old image with key:', course.knowledgePartImageKey1)
          await deleteFromS3(course.knowledgePartImageKey1)
        }

        // Create a guaranteed clean filename with no user input
        const timestamp = Date.now()
        const uniqueId = Math.random().toString(36).substring(2, 10)
        const fileType = req.files.knowledgePartImage1[0].mimetype.split('/')[1] || 'png'

        // Build a completely safe key
        const imageKey = `course-knowledge/${courseId}/part1-${timestamp}-${uniqueId}.${fileType}`
        console.log('Generated new image key:', imageKey)

        const imageUrl = await uploadToS3(req.files.knowledgePartImage1[0], imageKey)
        console.log('Uploaded to S3, received URL:', imageUrl)

        uploadedImageKeys.push(imageKey)
        updateData.knowledgePartImage1 = imageUrl
        updateData.knowledgePartImageKey1 = imageKey
        console.log('Added image1 to updateData')
      } catch (uploadError) {
        console.error('Error processing knowledgePartImage1:', uploadError)
        return next(new AppError(`Error uploading image 1: ${uploadError.message}`, 500))
      }
    }

    // Process knowledgePartImage2
    console.log('Processing knowledgePartImage2...')
    if (req.files?.knowledgePartImage2?.[0]) {
      console.log('Found knowledgePartImage2 file:', req.files.knowledgePartImage2[0].originalname)

      try {
        // Delete old image if exists
        if (course.knowledgePartImageKey2) {
          console.log('Deleting old image with key:', course.knowledgePartImageKey2)
          await deleteFromS3(course.knowledgePartImageKey2)
        }

        // Create a guaranteed clean filename with no user input
        const timestamp = Date.now()
        const uniqueId = Math.random().toString(36).substring(2, 10)
        const fileType = req.files.knowledgePartImage2[0].mimetype.split('/')[1] || 'png'

        // Build a completely safe key
        const imageKey = `course-knowledge/${courseId}/part2-${timestamp}-${uniqueId}.${fileType}`
        console.log('Generated new image key:', imageKey)

        const imageUrl = await uploadToS3(req.files.knowledgePartImage2[0], imageKey)
        console.log('Uploaded to S3, received URL:', imageUrl)

        uploadedImageKeys.push(imageKey)
        updateData.knowledgePartImage2 = imageUrl
        updateData.knowledgePartImageKey2 = imageKey
        console.log('Added image2 to updateData')
      } catch (uploadError) {
        console.error('Error processing knowledgePartImage2:', uploadError)
        return next(new AppError(`Error uploading image 2: ${uploadError.message}`, 500))
      }
    }

    // Process knowledgePartImage3
    console.log('Processing knowledgePartImage3...')
    if (req.files?.knowledgePartImage3?.[0]) {
      console.log('Found knowledgePartImage3 file:', req.files.knowledgePartImage3[0].originalname)

      try {
        // Delete old image if exists
        if (course.knowledgePartImageKey3) {
          console.log('Deleting old image with key:', course.knowledgePartImageKey3)
          await deleteFromS3(course.knowledgePartImageKey3)
        }

        // Create a guaranteed clean filename with no user input
        const timestamp = Date.now()
        const uniqueId = Math.random().toString(36).substring(2, 10)
        const fileType = req.files.knowledgePartImage3[0].mimetype.split('/')[1] || 'png'

        // Build a completely safe key
        const imageKey = `course-knowledge/${courseId}/part3-${timestamp}-${uniqueId}.${fileType}`
        console.log('Generated new image key:', imageKey)

        const imageUrl = await uploadToS3(req.files.knowledgePartImage3[0], imageKey)
        console.log('Uploaded to S3, received URL:', imageUrl)

        uploadedImageKeys.push(imageKey)
        updateData.knowledgePartImage3 = imageUrl
        updateData.knowledgePartImageKey3 = imageKey
        console.log('Added image3 to updateData')
      } catch (uploadError) {
        console.error('Error processing knowledgePartImage3:', uploadError)
        return next(new AppError(`Error uploading image 3: ${uploadError.message}`, 500))
      }
    }

    // If no files uploaded, return error
    console.log('Update data length:', Object.keys(updateData).length)
    if (Object.keys(updateData).length === 0) {
      console.log('No update data was created, despite having files in request')
      return next(new AppError('No images provided for upload', 400))
    }

    console.log('Updating course with data:', updateData)
    // Update the course with the new image URLs
    const updatedCourse = await Course.findByIdAndUpdate(courseId, updateData, { new: true, runValidators: true })

    console.log('Course updated successfully')
    res.status(200).json({
      message: 'Knowledge part images uploaded successfully',
      data: updatedCourse,
    })
  } catch (error) {
    console.error('Error in uploadKnowledgeImages:', error)
    // Attempt to clean up any uploaded images if operation fails
    if (uploadedImageKeys.length > 0) {
      for (const key of uploadedImageKeys) {
        try {
          await deleteFromS3(key)
        } catch (cleanupError) {
          console.error('Error cleaning up uploaded image:', cleanupError)
        }
      }
    }
    next(error)
  }
}

exports.deleteKnowledgeImage = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.courseId)) {
      return next(new AppError('Invalid course ID', 400))
    }

    const courseId = req.params.courseId
    const { part } = req.params

    if (part !== '1' && part !== '2' && part !== '3') {
      return next(new AppError('Invalid part number. Must be 1, 2, or 3', 400))
    }

    // Validate that the course exists
    const course = await Course.findById(courseId)
    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    const updateData = {}

    // Delete the image based on the part number
    if (part === '1') {
      if (course.knowledgePartImageKey1) {
        await deleteFromS3(course.knowledgePartImageKey1)
        updateData.knowledgePartImage1 = null
        updateData.knowledgePartImageKey1 = null
      } else {
        return next(new AppError('No image found for knowledge part 1', 404))
      }
    } else if (part === '2') {
      if (course.knowledgePartImageKey2) {
        await deleteFromS3(course.knowledgePartImageKey2)
        updateData.knowledgePartImage2 = null
        updateData.knowledgePartImageKey2 = null
      } else {
        return next(new AppError('No image found for knowledge part 2', 404))
      }
    } else {
      // part === '3'
      if (course.knowledgePartImageKey3) {
        await deleteFromS3(course.knowledgePartImageKey3)
        updateData.knowledgePartImage3 = null
        updateData.knowledgePartImageKey3 = null
      } else {
        return next(new AppError('No image found for knowledge part 3', 404))
      }
    }

    // Update the course to remove the image references
    const updatedCourse = await Course.findByIdAndUpdate(courseId, updateData, { new: true, runValidators: true })

    res.status(200).json({
      message: `Knowledge part ${part} image deleted successfully`,
      data: updatedCourse,
    })
  } catch (error) {
    console.error('Error in deleteKnowledgeImage:', error)
    next(error)
  }
}

// Helper function
async function checkPrerequisites(prerequisites, userId, courseId) {
  if (!prerequisites || prerequisites.length === 0) {
    return true // No prerequisites, so access is granted
  }

  try {
    const user = await User.findById(userId)
    if (!user) {
      return false // User not found
    }

    const enrollment = user.enrolledCourses.find((ec) => ec.course.toString() === courseId)
    if (!enrollment) {
      return false // User not enrolled in the course
    }

    // Iterate through prerequisites and check if each is met
    for (const prereq of prerequisites) {
      if (prereq.type === 'module') {
        const moduleCompleted = enrollment.enrolledModules.some(
          (enrolledModule) =>
            enrolledModule.module.toString() === prereq.moduleId.toString() && 
            enrolledModule.completedLessons.length >= prereq.minLessonsCompleted && 
            enrolledModule.completedQuizzes.length >= prereq.minQuizzesPassed 
        )
        if (!moduleCompleted) {
          return false // This module prerequisite is not met
        }
      } else {
        return false // Unknown prerequisite type
      }
    }

    return true // All prerequisites are met
  } catch (error) {
    console.error('Error checking prerequisites:', error)
    return false // Assume prerequisites are not met on error
  }
}