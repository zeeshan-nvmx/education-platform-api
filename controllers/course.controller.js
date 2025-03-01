const Joi = require('joi')
const mongoose = require('mongoose')
const { Course, Module, User, Progress, Lesson, Quiz, QuizAttempt, LessonProgress, VideoProgress, AssetProgress } = require('../models') // Import all necessary models
const { AppError } = require('../utils/errors')
const { uploadToS3, deleteFromS3 } = require('../utils/s3')
const sanitizeHtml = require('sanitize-html')

const instructorSchema = Joi.object({
  name: Joi.string().required().trim(),
  description: Joi.string().trim(),
  designation: Joi.string().trim(),
  expertise: Joi.array().items(Joi.string().trim()),
  socialLinks: Joi.object({
    linkedin: Joi.string().uri().allow(''),
    twitter: Joi.string().uri().allow(''),
    website: Joi.string().uri().allow(''),
  }),
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

//     if (value.modulePrice > value.price) {
//       return next(new AppError('Module price cannot be greater than course price', 400))
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
    if (req.query.search) {
      query.$or = [{ title: new RegExp(req.query.search, 'i') }, { description: new RegExp(req.query.search, 'i') }]
    }

    const totalCourses = await Course.countDocuments(query)

    // Conditional population based on authentication
    let coursesQuery = Course.find(query)
      .select('title description category thumbnail price rating totalStudents featured createdAt creator modules')
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

//     // Check for authenticated user
//     let authenticatedUser = null
//     let enrollment = null

//     if (userId) {
//       // Fetch the full user to get enrollment data
//       authenticatedUser = await User.findById(userId)
//       console.log(`Found authenticated user: ${authenticatedUser?.firstName} ${authenticatedUser?.lastName}`)

//       // Log the user's enrolled courses
//       console.log(`User enrolled courses count: ${authenticatedUser?.enrolledCourses?.length || 0}`)

//       // Find enrollment for this specific course
//       if (authenticatedUser?.enrolledCourses?.length) {
//         enrollment = authenticatedUser.enrolledCourses.find((ec) => ec.course && ec.course.toString() === courseId)

//         if (enrollment) {
//           console.log(`User has enrollment for this course. Type: ${enrollment.enrollmentType}`)
//           console.log(`Enrolled modules count: ${enrollment.enrolledModules?.length || 0}`)

//           // Log each enrolled module
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

//     // Determine roles
//     const isCreator = authenticatedUser && course.creator && course.creator._id.toString() === authenticatedUser._id.toString()
//     const isAdmin = authenticatedUser?.role === 'admin'
//     console.log(`User roles - Creator: ${isCreator}, Admin: ${isAdmin}`)

//     const courseDetails = {
//       _id: course._id,
//       title: course.title || '',
//       description: course.description || '',
//       longDescription: course.longDescription || '',
//       category: course.category || '',
//       price: course.price || 0,
//       thumbnail: course.thumbnail || '',
//       rating: course.rating || 0,
//       totalStudents: course.totalStudents || 0,
//       featured: course.featured || false,
//       creator: course.creator
//         ? {
//             name: `${course.creator.firstName || ''} ${course.creator.lastName || ''}`.trim(),
//             email: isAdmin || isCreator ? course.creator.email : undefined,
//           }
//         : { name: 'Unknown Creator' },
//       instructors: Array.isArray(course.instructors)
//         ? course.instructors.map((instructor) => ({
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

//     let moduleProgress = {}
//     if (enrollment && authenticatedUser?._id) {
//       const progress = await Progress.find({
//         user: authenticatedUser._id,
//         course: course._id,
//       }).lean()

//       moduleProgress = progress.reduce((acc, p) => {
//         if (p && p.module) {
//           acc[p.module.toString()] = p
//         }
//         return acc
//       }, {})
//     }

//     const hasFullAccess = isCreator || isAdmin || (enrollment && enrollment.enrollmentType === 'full')
//     console.log(`User has full access: ${hasFullAccess}`)

//     // Create a map of enrolled module IDs for quick lookup
//     const enrolledModuleIds = new Set()
//     if (enrollment && Array.isArray(enrollment.enrolledModules)) {
//       enrollment.enrolledModules.forEach((em) => {
//         if (em && em.module) {
//           enrolledModuleIds.add(em.module.toString())
//         }
//       })
//     }
//     console.log(`Enrolled module IDs: ${Array.from(enrolledModuleIds).join(', ')}`)

//     const modules = Array.isArray(course.modules) ? course.modules : []
//     courseDetails.modules = modules
//       .map((module) => {
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
//         }

//         const currentProgress = moduleProgress[moduleId]
//         if (currentProgress) {
//           moduleData.progress = {
//             completedLessons: Array.isArray(currentProgress.completedLessons) ? currentProgress.completedLessons.length : 0,
//             completedQuizzes: Array.isArray(currentProgress.completedQuizzes) ? currentProgress.completedQuizzes.length : 0,
//             progress: currentProgress.progress || 0,
//             lastAccessed: currentProgress.lastAccessed || null,
//           }
//         }

//         if (hasModuleAccess) {
//           const lessons = Array.isArray(module.lessons) ? module.lessons : []
//           moduleData.lessons = lessons
//             .map((lesson) => {
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
//               }

//               if (lesson.quiz) {
//                 lessonData.quiz = {
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
//                 }
//               }

//               if (currentProgress) {
//                 lessonData.progress = {
//                   completed: Array.isArray(currentProgress.completedLessons) && currentProgress.completedLessons.includes(lesson._id),
//                   quizCompleted: lesson.quiz && Array.isArray(currentProgress.completedQuizzes) && currentProgress.completedQuizzes.includes(lesson.quiz._id),
//                 }
//               }

//               return lessonData
//             })
//             .filter(Boolean)
//         } else {
//           const lessons = Array.isArray(module.lessons) ? module.lessons : []
//           moduleData.lessons = lessons
//             .map((lesson) => {
//               if (!lesson) return null
//               return {
//                 _id: lesson._id,
//                 title: lesson.title || '',
//                 description: lesson.description || '',
//                 order: lesson.order || 0,
//                 duration: lesson.duration || 0,
//                 hasQuiz: !!lesson.quiz,
//                 hasVideo: !!lesson.videoUrl,
//                 totalAssets: Array.isArray(lesson.assets) ? lesson.assets.length : 0,
//               }
//             })
//             .filter(Boolean)
//         }

//         return moduleData
//       })
//       .filter(Boolean)

//     // Always include enrollment data if user is authenticated and has any enrollment
//     if (enrollment) {
//       console.log('Including enrollment data in response')

//       // Format the enrolledModules array properly
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

//     // Log the enrollment part of the response before sending
//     console.log('Enrollment in response:', JSON.stringify(finalResponse.data.enrollment))

//     res.status(200).json(finalResponse)
//   } catch (error) {
//     console.error('Error in getCourse:', error)
//     next(error)
//   }
// }

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

//     // --- Build the Course Data ---
//     const courseDetails = {
//       _id: course._id,
//       title: course.title || '',
//       description: course.description || '',
//       longDescription: course.longDescription || '',
//       category: course.category || '',
//       price: course.price || 0,
//       thumbnail: course.thumbnail || '',
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
//           const moduleProgress = await Progress.findOne({
//             user: userId,
//             course: courseId,
//             module: moduleId,
//           }).lean()

//           if (moduleProgress) {
//             moduleData.progress = {
//               completedLessons: moduleProgress.completedLessons.length,
//               completedQuizzes: moduleProgress.completedQuizzes.length,
//               progress: moduleProgress.progress,
//               lastAccessed: moduleProgress.lastAccessed,
//             }
//             courseProgress.totalModules += 1
//             if (moduleProgress.progress === 100) {
//               courseProgress.completedModules += 1
//             }
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
//                   quizCompleted: false,
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
//                     completed: false,
//                     //attempts: [], //Removed attempts
//                     canTake: false,
//                     remainingAttempts: 0,
//                   },
//                 }
//                 courseProgress.totalQuizzes += 1
//               }

//               // --- Fetch Lesson-Specific Progress ---
//               if (enrollment && userId) {
//                 // FIX: Fetch moduleProgress *INSIDE* the lesson loop
//                 const moduleProgress = await Progress.findOne({
//                   user: userId,
//                   course: courseId,
//                   module: moduleId, //This was already correct
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

//                   // FIX: Check against *this lesson's* quiz ID, using the correct moduleProgress
//                   const isQuizCompleted =
//                     moduleProgress && moduleProgress.completedQuizzes.some((completedQuizId) => completedQuizId.toString() === lesson.quiz._id.toString())

//                   lessonData.quiz.progress = {
//                     completed: isQuizCompleted,
//                     canTake: await checkQuizRequirements(userId, lesson._id),
//                     remainingAttempts: Math.max(lesson.quiz.maxAttempts - quizAttempts.length, 0),
//                   }
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

    // --- Build the Course Data ---
    const courseDetails = {
      _id: course._id,
      title: course.title || '',
      description: course.description || '',
      longDescription: course.longDescription || '',
      category: course.category || '',
      price: course.price || 0,
      thumbnail: course.thumbnail || '',
      rating: course.rating || 0,
      totalStudents: course.totalStudents || 0,
      featured: course.featured || false,
      creator: course.creator
        ? {
            name: `${course.creator.firstName || ''} ${course.creator.lastName || ''}`.trim(),
            email: isAdmin || isCreator ? course.creator.email : undefined, // Only show email to admin/creator
          }
        : { name: 'Unknown Creator' },
      instructors: Array.isArray(course.instructors)
        ? course.instructors.map((instructor) => ({
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


exports.updateCourse = async (req, res, next) => {
  let newUploadedImageKeys = []

  try {
    const courseData = JSON.parse(req.body.courseData || '{}')
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
      const oldInstructorImageKeys = course.instructors.filter((inst) => inst.imageKey).map((inst) => inst.imageKey)

      const instructorsWithImages = await handleInstructorImages(value.instructors, req.files?.instructorImages)
      newUploadedImageKeys = newUploadedImageKeys.concat(instructorsWithImages.filter((inst) => inst.imageKey).map((inst) => inst.imageKey))

      value.instructors = instructorsWithImages
      await cleanupInstructorImages(oldInstructorImageKeys)
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
      select: 'title description order price prerequisites isAccessible dependencies', // No isDeleted
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

        const isFullAccess = enrollment.enrollmentType === 'full'
        const isModuleEnrolled = enrollment.enrolledModules?.some((em) => em.module.toString() === module._id.toString())
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