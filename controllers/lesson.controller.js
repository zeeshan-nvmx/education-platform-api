const Joi = require('joi')
const mongoose = require('mongoose')
const { Lesson, Module, Progress, Quiz, User, LessonProgress, VideoProgress, AssetProgress, QuizAttempt } = require('../models')
const { AppError } = require('../utils/errors')
const CloudflareService = require('../utils/cloudflare')
const { uploadToS3, deleteFromS3, uploadMultipleToS3, deleteMultipleFromS3, fileConfig } = require('../utils/s3')
const sanitizeHtml = require('sanitize-html')

const lessonSchema = Joi.object({
  title: Joi.string().required().trim(),
  description: Joi.string().allow('').trim(),
  details: Joi.string().allow('').max(50000), // Rich text content
  order: Joi.number().integer().min(1).required(),

  completionRequirements: Joi.object({
    watchVideo: Joi.boolean().default(false),
    downloadAssets: Joi.array()
      .items(
        Joi.object({
          assetId: Joi.string().regex(/^[0-9a-fA-F]{24}$/),
          required: Joi.boolean().default(false),
        })
      )
      .default([]),
    minimumTimeSpent: Joi.number().min(0).default(0),
  }).default({}),

  requireQuizPass: Joi.boolean().default(false),

  quizSettings: Joi.object({
    required: Joi.boolean().default(false),
    minimumPassingScore: Joi.number().min(0).max(100).default(70),
    allowReview: Joi.boolean().default(true),
    blockProgress: Joi.boolean().default(true),
    showQuizAt: Joi.string().valid('before', 'after', 'any').default('after'),
    minimumTimeRequired: Joi.number().min(0).default(0),
  }).default({}),

  // New: Asset descriptions
  assetDescriptions: Joi.array().items(Joi.string().allow('').trim()).default([]),
}).options({ abortEarly: false })


const updateLessonSchema = Joi.object({
  title: Joi.string().trim(),
  description: Joi.string().allow('').trim(),
  details: Joi.string().allow('').max(50000),
  order: Joi.number().integer().min(1),

  completionRequirements: Joi.object({
    watchVideo: Joi.boolean(),
    downloadAssets: Joi.array()
      .items(
        Joi.object({
          assetId: Joi.string()
            .regex(/^[0-9a-fA-F]{24}$/)
            .message('Invalid assetId format. Must be a 24-character hex string.'), // Custom error message
          required: Joi.boolean(),
        })
      )
      .default([]), // Ensure it's always an array
    minimumTimeSpent: Joi.number().min(0),
  }).default({}), // Ensure it's an object

  requireQuizPass: Joi.boolean(),

  quizSettings: Joi.object({
    required: Joi.boolean(),
    minimumPassingScore: Joi.number().min(0).max(100),
    allowReview: Joi.boolean(),
    blockProgress: Joi.boolean(),
    showQuizAt: Joi.string().valid('before', 'after', 'any'),
    minimumTimeRequired: Joi.number().min(0),
  }).default({}),

  // assetDescriptions validation
  assetDescriptions: Joi.array().items(Joi.string().allow('').trim()).default([]),
}).options({ abortEarly: false })


// Helper Functions

// async function checkQuizRequirements(userId, lessonId) {
//   try {
//     const lesson = await Lesson.findById(lessonId).populate('quiz')
//     if (!lesson || !lesson.quiz) return true // No quiz means requirements are met

//     // Only check if the quiz exists and is required
//     if (lesson.quizSettings?.required) {
//       return await validateQuizCompletion(userId, lessonId)
//     }

//     return true
//   } catch (error) {
//     console.error('Error checking quiz requirements:', error)
//     return false
//   }
// }

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

// async function validateQuizCompletion(userId, lessonId) {
//   try {
//     const lesson = await Lesson.findById(lessonId).populate('quiz')
//     if (!lesson || !lesson.quiz) return true

//     const attempts = await QuizAttempt.find({
//       quiz: lesson.quiz._id,
//       user: userId,
//       status: { $in: ['completed', 'grading'] },
//     }).sort('-submittedAt')

//     if (!attempts.length) return false

//     const latestAttempt = attempts[0]

//     // If attempt is still being graded
//     if (latestAttempt.status === 'grading' || !latestAttempt.gradingComplete) {
//       return false
//     }

//     // Check if passing score was achieved
//     const requiredScore = lesson.quizSettings?.minimumPassingScore || lesson.quiz.passingScore
//     return latestAttempt.percentage >= requiredScore
//   } catch (error) {
//     console.error('Error validating quiz completion:', error)
//     return false
//   }
// }

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

async function trackLessonTime(userId, lessonId, timeSpent) {
  try {
    let progress = await LessonProgress.findOne({
      user: userId,
      lesson: lessonId,
    })

    if (!progress) {
      progress = new LessonProgress({
        user: userId,
        lesson: lessonId,
        timeSpent: 0,
        lastAccessed: new Date(),
      })
    }

    progress.timeSpent += timeSpent
    progress.lastAccessed = new Date()
    await progress.save()

    return progress.timeSpent
  } catch (error) {
    console.error('Error tracking lesson time:', error)
    throw error
  }
}

async function trackAssetDownload(userId, lessonId, assetId) {
  try {
    const download = await AssetProgress.findOne({
      user: userId,
      lesson: lessonId,
      asset: assetId,
    })

    if (!download) {
      await AssetProgress.create({
        user: userId,
        lesson: lessonId,
        asset: assetId,
        downloadCount: 1,
        firstDownloaded: new Date(),
        lastDownloaded: new Date(),
      })
    } else {
      download.downloadCount += 1
      download.lastDownloaded = new Date()
      await download.save()
    }

    // Update lesson asset download count
    await Lesson.findOneAndUpdate({ _id: lessonId, 'assets._id': assetId }, { $inc: { 'assets.$.downloadCount': 1 } })

    return true
  } catch (error) {
    console.error('Error tracking asset download:', error)
    throw error
  }
}

// async function updateProgress(userId, courseId, moduleId, lessonId, quizId = null) {
//   const session = await mongoose.startSession()
//   session.startTransaction()

//   try {
//     let progress = await Progress.findOne({
//       user: userId,
//       course: courseId,
//       module: moduleId,
//     }).session(session)

//     const lesson = await Lesson.findById(lessonId).populate('quiz').session(session)

//     if (!lesson) {
//       throw new Error('Lesson not found')
//     }

//     const requirements = lesson.completionRequirements
//     let canComplete = true

//     // Check video requirement
//     if (requirements.watchVideo && lesson.videoUrl) {
//       const videoProgress = await VideoProgress.findOne({
//         user: userId,
//         lesson: lessonId,
//       }).session(session)

//       if (!videoProgress?.completed) {
//         canComplete = false
//       }
//     }

//     // Check required assets
//     if (requirements.downloadAssets?.length > 0) {
//       const requiredAssets = requirements.downloadAssets.filter((asset) => asset.required)
//       if (requiredAssets.length > 0) {
//         const downloads = await AssetProgress.countDocuments({
//           user: userId,
//           lesson: lessonId,
//           asset: { $in: requiredAssets.map((a) => a.assetId) },
//         }).session(session)

//         if (downloads < requiredAssets.length) {
//           canComplete = false
//         }
//       }
//     }

//     // Check minimum time requirement
//     if (requirements.minimumTimeSpent > 0) {
//       const timeProgress = await LessonProgress.findOne({
//         user: userId,
//         lesson: lessonId,
//       }).session(session)

//       if (!timeProgress || timeProgress.timeSpent < requirements.minimumTimeSpent * 60) {
//         canComplete = false
//       }
//     }

//     // Check quiz requirements if quiz exists
//     if (lesson.quiz) {
//       const quizCompleted = await validateQuizCompletion(userId, lessonId)
//       if (!quizCompleted) {
//         canComplete = false
//       }
//     }

//     if (!progress) {
//       progress = await Progress.create(
//         [
//           {
//             user: userId,
//             course: courseId,
//             module: moduleId,
//             completedLessons: canComplete ? [lessonId] : [],
//             completedQuizzes: quizId && canComplete ? [quizId] : [],
//             lastAccessed: new Date(),
//           },
//         ],
//         { session }
//       )
//     } else {
//       if (canComplete && !progress.completedLessons.includes(lessonId)) {
//         progress.completedLessons.push(lessonId)
//       }
//       if (quizId && canComplete && !progress.completedQuizzes.includes(quizId)) {
//         progress.completedQuizzes.push(quizId)
//       }
//       progress.lastAccessed = new Date()

//       const totalLessons = await Lesson.countDocuments({
//         module: moduleId,
//         isDeleted: false,
//       }).session(session)

//       progress.progress = (progress.completedLessons.length / totalLessons) * 100
//       await progress.save({ session })
//     }

//     await session.commitTransaction()
//     return {
//       canComplete,
//       progress: progress.progress,
//       completedLessons: progress.completedLessons,
//       completedQuizzes: progress.completedQuizzes,
//     }
//   } catch (error) {
//     await session.abortTransaction()
//     throw error
//   } finally {
//     session.endSession()
//   }
// }

async function updateProgress(userId, courseId, moduleId, lessonId, quizId = null) {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    let progress = await Progress.findOne({
      user: userId,
      course: courseId,
      module: moduleId,
    }).session(session)

    const lesson = await Lesson.findById(lessonId).populate('quiz').session(session)

    if (!lesson) {
      throw new Error('Lesson not found')
    }

    let canComplete = true

    // Check quiz requirements if quiz exists and is required
    if (lesson.quiz && lesson.quizSettings?.required) {
      const quizCompleted = await validateQuizCompletion(userId, lessonId)
      if (!quizCompleted) {
        canComplete = false
      }
    }

    if (!progress) {
      progress = await Progress.create(
        [
          {
            user: userId,
            course: courseId,
            module: moduleId,
            completedLessons: canComplete ? [lessonId] : [],
            completedQuizzes: quizId && canComplete ? [quizId] : [],
            lastAccessed: new Date(),
          },
        ],
        { session }
      )
    } else {
      if (canComplete && !progress.completedLessons.includes(lessonId)) {
        progress.completedLessons.push(lessonId)
      }
      if (quizId && canComplete && !progress.completedQuizzes.includes(quizId)) {
        progress.completedQuizzes.push(quizId)
      }
      progress.lastAccessed = new Date()

      const totalLessons = await Lesson.countDocuments({
        module: moduleId,
        isDeleted: false,
      }).session(session)

      progress.progress = (progress.completedLessons.length / totalLessons) * 100
      await progress.save({ session })
    }

    await session.commitTransaction()
    return {
      canComplete,
      progress: progress.progress,
      completedLessons: progress.completedLessons,
      completedQuizzes: progress.completedQuizzes,
    }
  } catch (error) {
    await session.abortTransaction()
    throw error
  } finally {
    session.endSession()
  }
}

async function validateAssetIds(assetIds, lessonId) {
  if (!assetIds?.length) return true

  const lesson = await Lesson.findById(lessonId)
  if (!lesson) return false

  return assetIds.every((assetId) => lesson.assets.some((asset) => asset._id.toString() === assetId))
}

async function checkModuleAccess(userId, courseId, moduleId) {
  const user = await User.findOne({ _id: userId }).select('+role')

  if (!user) return false

  // Check if user is admin/subAdmin/moderator
  if (['admin', 'subAdmin', 'moderator'].includes(user.role)) {
    return true
  }

  // For regular users, check course enrollment
  const enrollment = user.enrolledCourses?.find((ec) => ec.course.toString() === courseId)
  if (!enrollment) return false

  if (enrollment.enrollmentType === 'full') return true

  return enrollment.enrolledModules.some((em) => em.module.toString() === moduleId)
}

// Create Lesson
exports.createLesson = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { error, value } = lessonSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
    }

    // Sanitize rich text content
    if (value.details) {
      value.details = sanitizeHtml(value.details, {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img']),
        allowedAttributes: {
          ...sanitizeHtml.defaults.allowedAttributes,
          img: ['src', 'alt'],
        },
      })
    }

    // Check if module exists
    const module = await Module.findOne({
      _id: req.params.moduleId,
      course: req.params.courseId,
      isDeleted: false,
    }).session(session)

    if (!module) {
      await session.abortTransaction()
      return next(new AppError('Module not found', 404))
    }

    // Check for duplicate order
    const existingLesson = await Lesson.findOne({
      module: req.params.moduleId,
      order: value.order,
      isDeleted: false,
    }).session(session)

    if (existingLesson) {
      await session.abortTransaction()
      return next(new AppError('A lesson with this order number already exists', 400))
    }

    // Handle file uploads if any
    let assets = []
    if (req.files?.length) {
      try {
        const uploadPromises = req.files.map((file) =>
          uploadToS3(file, null, {
            type: 'lesson_asset',
            customPrefix: `lesson-${req.params.moduleId}`,
            metadata: {
              moduleId: req.params.moduleId,
              courseId: req.params.courseId,
            },
          })
        )

        const uploadedUrls = await Promise.all(uploadPromises)

        assets = uploadedUrls.map((url, index) => ({
          title: req.files[index].originalname,
          description: req.body.assetDescriptions?.[index] || '',
          fileUrl: url,
          fileKey: url.split('/').pop(),
          fileType: req.files[index].mimetype,
          fileSize: req.files[index].size,
          uploadedAt: new Date(),
          isPublic: false,
        }))
      } catch (error) {
        await session.abortTransaction()
        return next(new AppError('Error uploading assets', 500))
      }
    }

    // Create the lesson
    const lesson = await Lesson.create(
      [
        {
          ...value,
          module: req.params.moduleId,
          assets,
        },
      ],
      { session }
    )

    await session.commitTransaction()

    // Fetch the created lesson with populated fields
    const populatedLesson = await Lesson.findById(lesson[0]._id).populate({
      path: 'quiz',
      select: 'title type passingScore',
      match: { isDeleted: false },
    })

    res.status(201).json({
      status: 'success',
      message: 'Lesson created successfully',
      data: populatedLesson,
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.getLessons = async (req, res, next) => {
  try {
    const { courseId, moduleId } = req.params
    const userId = req.user._id
    const user = await User.findById(userId).select('+role +enrolledCourses').lean()
    if (!user) {
      return next(new AppError('User not found', 404))
    }
    // Check if user is admin
    const isAdmin = ['admin', 'subAdmin', 'moderator'].includes(user.role)
    if (isAdmin) {
      // Admins have access to everything
      const lessons = await Lesson.find({
        module: moduleId,
        isDeleted: false,
      })
        .sort('order')
        .populate([
          {
            path: 'quiz',
            select: 'title type passingScore',
            match: { isDeleted: false },
          },
        ])
        .lean()
      return res.status(200).json({
        status: 'success',
        message: 'Lessons retrieved successfully (Admin)',
        data: lessons,
      })
    }
    // If NOT admin, check for enrollment
    const enrolledCourse = user.enrolledCourses?.find((ec) => ec.course.toString() === courseId)
    if (!enrolledCourse) {
      return next(new AppError('You do not have access to this course', 403))
    }
    // Check for module access (full course or specific module)
    const hasModuleAccess = enrolledCourse.enrollmentType === 'full' || enrolledCourse.enrolledModules?.some((em) => em.module.toString() === moduleId)
    if (!hasModuleAccess) {
      return next(new AppError('You do not have access to this module', 403))
    }
    // Fetch lessons
    const lessons = await Lesson.find({
      module: moduleId,
      isDeleted: false,
    })
      .sort('order')
      .populate([
        {
          path: 'quiz',
          select: 'title type passingScore',
          match: { isDeleted: false },
        },
      ])
      .lean()
    // Get progress
    const progress = await Progress.findOne({
      user: userId,
      module: moduleId,
    }).lean()
    // Add progress information to lessons
    const lessonsWithProgress = lessons.map((lesson) => {
      const lessonObj = { ...lesson }
      
      if (progress) {
        lessonObj.completed = progress.completedLessons.some((lessonId) => lessonId.toString() === lesson._id.toString())

        if (lesson.quiz) {
          lessonObj.quiz.completed = progress.completedQuizzes.some((quizId) => quizId.toString() === lesson.quiz._id.toString())
        }
      }

      // Keep the assets structure but simplify
      if (lesson.assets?.length > 0) {
        lessonObj.assets = lesson.assets.map((asset) => ({
          id: asset.id,
          title: asset.title,
          description: asset.description,
          fileUrl: asset.fileUrl,
          fileType: asset.fileType,
          fileSize: asset.fileSize,
          downloadCount: asset.downloadCount,
          uploadedAt: asset.uploadedAt,
        }))
      }
      return lessonObj
    })
    res.status(200).json({
      status: 'success',
      message: 'Lessons retrieved successfully',
      data: lessonsWithProgress,
    })
  } catch (error) {
    next(error)
  }
}


// exports.getLesson = async (req, res, next) => {
//   try {
//     const { courseId, moduleId, lessonId } = req.params
//     const userId = req.user._id

//     const user = await User.findById(userId).select('+role +enrolledCourses').lean()
//     if (!user) {
//       return next(new AppError('User not found', 404))
//     }

//     const isAdmin = ['admin', 'subAdmin', 'moderator'].includes(user.role)

//     if (!isAdmin) {
//       const enrolledCourse = user.enrolledCourses?.find((ec) => ec.course.toString() === courseId)
//       if (!enrolledCourse) {
//         return next(new AppError('You do not have access to this course', 403))
//       }
//       const hasAccess = enrolledCourse.enrollmentType === 'full' || enrolledCourse.enrolledModules.some((em) => em.module.toString() === moduleId)
//       if (!hasAccess) {
//         return next(new AppError('You do not have access to this module', 403))
//       }
//     }

//     const lesson = await Lesson.findOne({ _id: lessonId, module: moduleId, isDeleted: false }).populate('quiz').lean()
//     if (!lesson) {
//       return next(new AppError('Lesson not found', 404))
//     }

//     const progress = await Progress.findOne({ user: userId, module: moduleId }).lean()
//     const previousLesson = await Lesson.findOne({ module: moduleId, order: lesson.order - 1, isDeleted: false })
//       .populate('quiz')
//       .lean()

//     if (!isAdmin && previousLesson?.quiz && previousLesson.quizSettings.blockProgress) {
//       const isPreviousQuizCompleted = progress?.completedQuizzes.includes(previousLesson.quiz._id.toString())
//       if (!isPreviousQuizCompleted) {
//         return next(new AppError('Access denied - complete previous quiz first', 403))
//       }
//     }

//     const responseData = {
//       _id: lesson._id,
//       title: lesson.title,
//       description: lesson.description,
//       details: lesson.details,
//       module: lesson.module,
//       order: lesson.order,
//       videoUrl: lesson.videoUrl,
//       dashUrl: lesson.dashUrl,
//       rawUrl: lesson.rawUrl,
//       cloudflareVideoId: lesson.cloudflareVideoId,
//       duration: lesson.duration,
//       thumbnail: lesson.thumbnail,
//       videoMeta: lesson.videoMeta,
//       assets: lesson.assets?.map((asset) => ({
//         _id: asset._id,
//         title: asset.title,
//         description: asset.description,
//         fileUrl: asset.fileUrl,
//         fileType: asset.fileType,
//         fileSize: asset.fileSize,
//         downloadCount: asset.downloadCount,
//         uploadedAt: asset.uploadedAt,
//       })),
//       quizSettings: lesson.quizSettings,
//       completionRequirements: lesson.completionRequirements,
//     }

//     if (!isAdmin) {
//       responseData.progress = {
//         completed: progress?.completedLessons?.some((id) => id.toString() === lessonId) || false,
//         timeSpent: 0,
//         videoProgress: null,
//         assetDownloads: {},
//       }

//       if (lesson.quiz) {
//         const quizAttempts = await QuizAttempt.find({ quiz: lesson.quiz._id, user: userId }).sort('-submittedAt').lean()
//         const isQuizCompleted = progress?.completedQuizzes?.some((quizId) => quizId.toString() === lesson.quiz._id.toString()) || false

//         responseData.progress.quiz = {
//           completed: isQuizCompleted,
//           attempts: quizAttempts.map((attempt) => ({
//             id: attempt._id,
//             score: attempt.score,
//             percentage: attempt.percentage,
//             passed: attempt.passed,
//             status: attempt.status,
//             submittedAt: attempt.submittedAt,
//           })),
//           canTake: !isQuizCompleted,
//           remainingAttempts: Math.max(lesson.quiz.maxAttempts - quizAttempts.length, 0),
//         }
//       }
//     }

//     res.status(200).json({
//       status: 'success',
//       message: 'Lesson retrieved successfully',
//       data: responseData,
//     })
//   } catch (error) {
//     next(error)
//   }
// }

exports.getLesson = async (req, res, next) => {
  try {
    const { courseId, moduleId, lessonId } = req.params
    const userId = req.user._id

    const user = await User.findById(userId).select('+role +enrolledCourses').lean()
    if (!user) {
      return next(new AppError('User not found', 404))
    }

    const isAdmin = ['admin', 'subAdmin', 'moderator'].includes(user.role)

    if (!isAdmin) {
      const enrolledCourse = user.enrolledCourses?.find((ec) => ec.course.toString() === courseId)
      if (!enrolledCourse) {
        return next(new AppError('You do not have access to this course', 403))
      }
      const hasAccess = enrolledCourse.enrollmentType === 'full' || enrolledCourse.enrolledModules.some((em) => em.module.toString() === moduleId)
      if (!hasAccess) {
        return next(new AppError('You do not have access to this module', 403))
      }
    }

    const lesson = await Lesson.findOne({ _id: lessonId, module: moduleId, isDeleted: false }).populate('quiz').lean()
    if (!lesson) {
      return next(new AppError('Lesson not found', 404))
    }

    const progress = await Progress.findOne({ user: userId, module: moduleId }).lean()
    const previousLesson = await Lesson.findOne({ module: moduleId, order: lesson.order - 1, isDeleted: false })
      .populate('quiz')
      .lean()

    // Corrected prerequisite check:
    if (!isAdmin && previousLesson?.quiz && previousLesson.quizSettings?.blockProgress) {
      const isPreviousQuizCompleted = progress && progress.completedQuizzes.some((quizId) => quizId.toString() === previousLesson.quiz._id.toString())
      if (!isPreviousQuizCompleted) {
        return next(new AppError('Access denied - complete previous quiz first', 403))
      }
    }

    const responseData = {
      _id: lesson._id,
      title: lesson.title,
      description: lesson.description,
      details: lesson.details,
      module: lesson.module,
      order: lesson.order,
      videoUrl: lesson.videoUrl,
      dashUrl: lesson.dashUrl,
      rawUrl: lesson.rawUrl,
      cloudflareVideoId: lesson.cloudflareVideoId,
      duration: lesson.duration,
      thumbnail: lesson.thumbnail,
      videoMeta: lesson.videoMeta,
      assets: lesson.assets?.map((asset) => ({
        _id: asset._id,
        title: asset.title,
        description: asset.description,
        fileUrl: asset.fileUrl,
        fileType: asset.fileType,
        fileSize: asset.fileSize,
        downloadCount: asset.downloadCount,
        uploadedAt: asset.uploadedAt,
      })),
      quizSettings: lesson.quizSettings,
      completionRequirements: lesson.completionRequirements,
    }

    if (!isAdmin) {
      responseData.progress = {
        completed: progress?.completedLessons?.some((id) => id.toString() === lessonId) || false,
        timeSpent: 0,
        videoProgress: null,
        assetDownloads: {},
      }

      if (lesson.quiz) {
        const quizAttempts = await QuizAttempt.find({ quiz: lesson.quiz._id, user: userId }).sort('-submittedAt').lean()
        const isQuizCompleted = progress?.completedQuizzes?.some((quizId) => quizId.toString() === lesson.quiz._id.toString()) || false

        responseData.progress.quiz = {
          completed: isQuizCompleted,
          attempts: quizAttempts.map((attempt) => ({ //Removed attempts
           id: attempt._id,
           score: attempt.score,
           percentage: attempt.percentage,
           passed: attempt.passed,
           status: attempt.status,
           submittedAt: attempt.submittedAt,
          })),
          canTake: !isQuizCompleted,
          remainingAttempts: Math.max(lesson.quiz.maxAttempts - quizAttempts.length, 0),
        }
      }
    }

    res.status(200).json({
      status: 'success',
      message: 'Lesson retrieved successfully',
      data: responseData,
    })
  } catch (error) {
    next(error)
  }
}

exports.updateLesson = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { error, value } = updateLessonSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        }))
      })
    }

    // Sanitize rich text if provided
    if (value.details) {
      value.details = sanitizeHtml(value.details, {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img']),
        allowedAttributes: {
          ...sanitizeHtml.defaults.allowedAttributes,
          img: ['src', 'alt']
        }
      })
    }

    // Check for duplicate order if order is being updated
    if (value.order) {
      const existingLesson = await Lesson.findOne({
        module: req.params.moduleId,
        order: value.order,
        _id: { $ne: req.params.lessonId },
        isDeleted: false,
      }).session(session)

      if (existingLesson) {
        await session.abortTransaction()
        return next(new AppError('A lesson with this order number already exists', 400))
      }
    }

    // Get existing lesson
    const lesson = await Lesson.findOne({
      _id: req.params.lessonId,
      module: req.params.moduleId,
      isDeleted: false,
    }).session(session)

    if (!lesson) {
      await session.abortTransaction()
      return next(new AppError('Lesson not found', 404))
    }

    // Handle new file uploads if any
    if (req.files?.length) {
      try {
        const uploadPromises = req.files.map(file => 
          uploadToS3(file, null, {
            type: 'lesson_asset',
            customPrefix: `lesson-${req.params.moduleId}`,
            metadata: {
              moduleId: req.params.moduleId,
              courseId: req.params.courseId
            }
          })
        )

        const uploadedUrls = await Promise.all(uploadPromises)
        
        const newAssets = uploadedUrls.map((url, index) => ({
          title: req.files[index].originalname,
          description: req.body.assetDescriptions?.[index] || '',
          fileUrl: url,
          fileKey: url.split('/').pop(),
          fileType: req.files[index].mimetype,
          fileSize: req.files[index].size,
          uploadedAt: new Date(),
          isPublic: false
        }))

        // Append new assets to existing ones
        value.assets = [...(lesson.assets || []), ...newAssets]
      } catch (error) {
        await session.abortTransaction()
        return next(new AppError('Error uploading assets', 500))
      }
    }

    // Update completion requirements validation
    if (value.completionRequirements?.downloadAssets) {
      const validAssets = await validateAssetIds(
        value.completionRequirements.downloadAssets.map(a => a.assetId),
        lesson._id
      )
      if (!validAssets) {
        await session.abortTransaction()
        return next(new AppError('Invalid asset IDs in completion requirements', 400))
      }
    }

    // Update the lesson
    const updatedLesson = await Lesson.findOneAndUpdate(
      {
        _id: req.params.lessonId,
        module: req.params.moduleId,
        isDeleted: false,
      },
      value,
      {
        new: true,
        runValidators: true,
        session,
      }
    ).populate({
      path: 'quiz',
      select: 'title type passingScore',
      match: { isDeleted: false },
    })

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      message: 'Lesson updated successfully',
      data: updatedLesson,
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

// Asset Management
exports.addAssets = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    if (!req.files?.length) {
      return next(new AppError('No files provided', 400))
    }

    const lesson = await Lesson.findOne({
      _id: req.params.lessonId,
      module: req.params.moduleId,
      isDeleted: false,
    }).session(session)

    if (!lesson) {
      await session.abortTransaction()
      return next(new AppError('Lesson not found', 404))
    }

    // Upload new assets
    const uploadPromises = req.files.map(file => 
      uploadToS3(file, null, {
        type: 'lesson_asset',
        customPrefix: `lesson-${req.params.moduleId}/${req.params.lessonId}`,
        metadata: {
          lessonId: req.params.lessonId,
          moduleId: req.params.moduleId,
          courseId: req.params.courseId
        }
      })
    )

    const uploadedUrls = await Promise.all(uploadPromises)
    
    const newAssets = uploadedUrls.map((url, index) => ({
      title: req.files[index].originalname,
      description: req.body.assetDescriptions?.[index] || '',
      fileUrl: url,
      fileKey: url.split('/').pop(),
      fileType: req.files[index].mimetype,
      fileSize: req.files[index].size,
      downloadCount: 0,
      uploadedAt: new Date(),
      isPublic: req.body.isPublic === 'true'
    }))

    // Add new assets to lesson
    lesson.assets = [...(lesson.assets || []), ...newAssets]
    await lesson.save({ session })

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      message: 'Assets uploaded successfully',
      data: {
        assets: newAssets
      }
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

// Asset-related operations are now part of updateLesson
exports.updateAsset = async (req, res, next) => {
  try {
    const { lessonId, assetId } = req.params
    const { title, description, isPublic } = req.body

    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: req.params.moduleId,
      isDeleted: false,
      'assets._id': assetId
    })

    if (!lesson) {
      return next(new AppError('Lesson or asset not found', 404))
    }

    const asset = lesson.assets.id(assetId)
    if (title) asset.title = title
    if (description) asset.description = description
    if (typeof isPublic === 'boolean') asset.isPublic = isPublic

    await lesson.save()

    res.status(200).json({
      status: 'success',
      message: 'Asset updated successfully',
      data: { asset }
    })
  } catch (error) {
    next(error)
  }
}

exports.deleteAsset = async (req, res, next) => {
  try {
    const { lessonId, assetId } = req.params

    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: req.params.moduleId,
      isDeleted: false,
      'assets._id': assetId
    })

    if (!lesson) {
      return next(new AppError('Lesson or asset not found', 404))
    }

    const asset = lesson.assets.id(assetId)
    const fileKey = asset.fileKey

    // Remove asset from lesson
    lesson.assets = lesson.assets.filter(a => a._id.toString() !== assetId)
    await lesson.save()

    // Delete file from S3
    await deleteFromS3(fileKey)

    res.status(200).json({
      status: 'success',
      message: 'Asset deleted successfully'
    })
  } catch (error) {
    next(error)
  }
}

// Download Asset
exports.downloadAsset = async (req, res, next) => {
  try {
    const { courseId, moduleId, lessonId, assetId } = req.params
    const userId = req.user._id

    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
      'assets._id': assetId,
    })

    if (!lesson) {
      return next(new AppError('Asset not found', 404))
    }

    const asset = lesson.assets.id(assetId)
    if (!asset) {
      return next(new AppError('Asset not found', 404))
    }

    // Check access
    const progress = await Progress.findOne({
      user: userId,
      module: moduleId,
    })

    if (!asset.isPublic && !progress?.completedLessons.includes(lessonId)) {
      return next(new AppError('You must complete the lesson to access this asset', 403))
    }

    // Track download
    await trackAssetDownload(userId, lessonId, assetId)

    // Generate download URL
    const downloadUrl = await generatePresignedUrl(asset.fileKey, 300) // 5 minutes

    res.status(200).json({
      status: 'success',
      message: 'Asset download URL generated',
      data: {
        downloadUrl,
        fileName: asset.title,
        fileType: asset.fileType,
      },
    })
  } catch (error) {
    next(error)
  }
}

// Delete Lesson
exports.deleteLesson = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const lesson = await Lesson.findOne({
      _id: req.params.lessonId,
      module: req.params.moduleId,
      isDeleted: false,
    }).session(session)

    if (!lesson) {
      await session.abortTransaction()
      return next(new AppError('Lesson not found', 404))
    }

    // Check if any students have completed this lesson
    const hasCompletions = await Progress.exists({
      module: req.params.moduleId,
      completedLessons: lesson._id,
    }).session(session)

    if (hasCompletions) {
      // Soft delete if there are completions
      lesson.isDeleted = true
      await lesson.save({ session })

      // Soft delete associated quiz if exists
      if (lesson.quiz) {
        await Quiz.findByIdAndUpdate(
          lesson.quiz,
          { isDeleted: true },
          { session }
        )
      }
    } else {
      // Delete associated files
      if (lesson.assets?.length) {
        const fileKeys = lesson.assets.map(asset => asset.fileKey)
        await deleteMultipleFromS3(fileKeys)
      }

      // Delete video if exists
      if (lesson.cloudflareVideoId) {
        await CloudflareService.deleteVideo(lesson.cloudflareVideoId)
      }

      // Hard delete lesson and associated quiz
      await Promise.all([
        Lesson.deleteOne({ _id: lesson._id }).session(session),
        Quiz.deleteOne({ lesson: lesson._id }).session(session)
      ])

      // Update order of remaining lessons
      await Lesson.updateMany(
        {
          module: req.params.moduleId,
          order: { $gt: lesson.order },
        },
        { $inc: { order: -1 } },
        { session }
      )
    }

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      message: 'Lesson deleted successfully',
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

// Track Lesson Progress

exports.trackProgress = async (req, res, next) => {
  try {
    const { lessonId } = req.params
    const userId = req.user._id

    // Update overall lesson progress
    const progressUpdate = await updateProgre
    ss(userId, req.params.courseId, req.params.moduleId, lessonId)

    res.status(200).json({
      status: 'success',
      message: 'Progress updated successfully',
      data: progressUpdate,
    })
  } catch (error) {
    next(error)
  }
}

// Video Management Functions

// //working for video files under 200mb
// exports.uploadLessonVideo = async (req, res, next) => {
//   const session = await mongoose.startSession()
//   session.startTransaction()

//   try {
//     if (!req.file) {
//       return next(new AppError('Please provide a video file', 400))
//     }

//     // Check file size (e.g., 200MB limit)
//     const maxSize = 1000 * 1024 * 1024 // 1000MB in bytes
//     if (req.file.size > maxSize) {
//       return next(new AppError('Video file too large. Maximum size is 200MB', 400))
//     }

//     // Check file type
//     if (!req.file.mimetype.startsWith('video/')) {
//       return next(new AppError('Please upload only video files', 400))
//     }

//     const lesson = await Lesson.findOne({
//       _id: req.params.lessonId,
//       module: req.params.moduleId,
//       isDeleted: false,
//     }).session(session)

//     if (!lesson) {
//       await session.abortTransaction()
//       return next(new AppError('Lesson not found', 404))
//     }

//     // If there's an existing video, delete it
//     if (lesson.cloudflareVideoId) {
//       try {
//         await CloudflareService.deleteVideo(lesson.cloudflareVideoId)
//       } catch (error) {
//         console.error('Error deleting existing video:', error)
//       }
//     }

//     // Upload new video
//     try {
//       const { videoId, videoDetails } = await CloudflareService.uploadVideo(req.file)

//       // Update lesson with all video details
//       lesson.videoUrl = videoDetails.playbackUrl
//       lesson.dashUrl = videoDetails.dashUrl
//       lesson.rawUrl = videoDetails.rawUrl
//       lesson.cloudflareVideoId = videoId
//       lesson.duration = videoDetails.duration || 0
//       lesson.thumbnail = videoDetails.thumbnail
//       lesson.videoMeta = {
//         size: videoDetails.meta.size,
//         created: videoDetails.meta.created,
//         modified: videoDetails.meta.modified,
//         status: videoDetails.meta.status,
//       }

//       // Reset video progress for all users
//       await VideoProgress.deleteMany({
//         lesson: lesson._id
//       }).session(session)

//       await lesson.save({ session })
//       await session.commitTransaction()

//       res.status(200).json({
//         message: 'Video uploaded successfully',
//         data: {
//           videoUrl: lesson.videoUrl,
//           dashUrl: lesson.dashUrl,
//           rawUrl: lesson.rawUrl,
//           duration: lesson.duration,
//           thumbnail: lesson.thumbnail,
//           videoMeta: lesson.videoMeta,
//         },
//       })
//     } catch (uploadError) {
//       console.error('Error during video upload:', uploadError)
//       await session.abortTransaction()
//       return next(new AppError('Failed to upload video. Please try again.', 500))
//     }
//   } catch (error) {
//     console.error('Error in uploadLessonVideo:', error)
//     await session.abortTransaction()
//     next(error)
//   } finally {
//     session.endSession()
//   }
// }

// tus upload for larger files
exports.uploadLessonVideo = async (req, res, next) => {
  try {
    // Initial validations before any operations
    if (!req.file) {
      return next(new AppError('Please provide a video file', 400))
    }

    // Check file size
    const maxSize = 5000 * 1024 * 1024 // 5GB in bytes
    if (req.file.size > maxSize) {
      return next(new AppError('Video file too large. Maximum size is 5 GB', 400))
    }

    // Check file type
    if (!req.file.mimetype.startsWith('video/')) {
      return next(new AppError('Please upload only video files', 400))
    }

    // First, find the lesson without transaction
    const lesson = await Lesson.findOne({
      _id: req.params.lessonId,
      module: req.params.moduleId,
      isDeleted: false,
    })

    if (!lesson) {
      return next(new AppError('Lesson not found', 404))
    }

    // Store old video ID for cleanup
    const oldVideoId = lesson.cloudflareVideoId

    // Upload new video to Cloudflare (outside transaction)
    let uploadResult
    try {
      uploadResult = await CloudflareService.uploadVideo(req.file)
    } catch (uploadError) {
      console.error('Error during video upload:', uploadError)
      return next(new AppError('Failed to upload video. Please try again.', 500))
    }

    // Now start MongoDB transaction for database updates
    const session = await mongoose.startSession()
    session.startTransaction()

    try {
      // Update lesson with all video details
      lesson.videoUrl = uploadResult.videoDetails.playbackUrl
      lesson.dashUrl = uploadResult.videoDetails.dashUrl
      lesson.rawUrl = uploadResult.videoDetails.rawUrl
      lesson.cloudflareVideoId = uploadResult.videoId
      lesson.duration = uploadResult.videoDetails.duration || 0
      lesson.thumbnail = uploadResult.videoDetails.thumbnail
      lesson.videoMeta = {
        size: uploadResult.videoDetails.meta.size,
        created: uploadResult.videoDetails.meta.created,
        modified: uploadResult.videoDetails.meta.modified,
        status: uploadResult.videoDetails.meta.status,
      }

      // Reset video progress for all users
      await VideoProgress.deleteMany({
        lesson: lesson._id,
      }).session(session)

      await lesson.save({ session })
      await session.commitTransaction()

      // After successful transaction, delete old video if it exists
      if (oldVideoId) {
        try {
          await CloudflareService.deleteVideo(oldVideoId)
        } catch (error) {
          console.error('Error deleting old video:', error)
          // Don't fail the request if old video deletion fails
        }
      }

      // Force garbage collection
      if (global.gc) {
        global.gc()
      }

      res.status(200).json({
        message: 'Video uploaded successfully',
        data: {
          videoUrl: lesson.videoUrl,
          dashUrl: lesson.dashUrl,
          rawUrl: lesson.rawUrl,
          duration: lesson.duration,
          thumbnail: lesson.thumbnail,
          videoMeta: lesson.videoMeta,
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
    console.error('Error in uploadLessonVideo:', error)
    next(error)
  }
}

exports.getVideoStreamUrl = async (req, res, next) => {
  try {
    const { courseId, moduleId, lessonId } = req.params
    const userId = req.user._id

    // Check module access
    const hasAccess = await checkModuleAccess(userId, courseId, moduleId)
    if (!hasAccess) {
      return next(new AppError('You do not have access to this module', 403))
    }

    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
    })

    if (!lesson) {
      return next(new AppError('Lesson not found', 404))
    }

    if (!lesson.cloudflareVideoId) {
      return next(new AppError('No video found for this lesson', 404))
    }

    // Check prerequisites
    const module = await Module.findById(moduleId)
    const prerequisitesMet = await module.prerequisites?.every(async prereqId => {
      const progress = await Progress.findOne({
        user: userId,
        module: prereqId
      })
      return progress?.progress === 100
    }) ?? true

    if (!prerequisitesMet) {
      return next(new AppError('Module prerequisites not met', 403))
    }

    // Check if previous lesson's quiz is required and completed
    if (lesson.quizSettings?.blockProgress && lesson.order > 1) {
      const prevLesson = await Lesson.findOne({
        module: moduleId,
        order: lesson.order - 1,
        isDeleted: false,
      }).populate('quiz')

      if (prevLesson?.quiz) {
        const progress = await Progress.findOne({
          user: userId,
          module: moduleId,
        })

        if (!progress?.completedQuizzes.includes(prevLesson.quiz._id)) {
          return next(new AppError("Previous lesson's quiz must be completed first", 403))
        }
      }
    }

    // Get video details from Cloudflare
    const videoDetails = await CloudflareService.getVideoDetails(lesson.cloudflareVideoId)

    // Create or update video progress
    let videoProgress = await VideoProgress.findOne({
      user: userId,
      lesson: lessonId
    })

    if (!videoProgress) {
      videoProgress = await VideoProgress.create({
        user: userId,
        lesson: lessonId,
        watchedTime: 0,
        lastPosition: 0,
        completed: false
      })
    }

    res.status(200).json({
      status: 'success',
      message: 'Video stream URL generated',
      data: {
        streamUrl: videoDetails.playbackUrl,
        dashUrl: videoDetails.dashUrl,
        duration: videoDetails.duration,
        thumbnail: videoDetails.thumbnail,
        progress: {
          lastPosition: videoProgress.lastPosition,
          watchedTime: videoProgress.watchedTime,
          completed: videoProgress.completed
        }
      }
    })
  } catch (error) {
    next(error)
  }
}

exports.markLessonComplete = async (req, res, next) => {
  try {
    const { courseId, moduleId, lessonId } = req.params
    const userId = req.user._id

    // Check access
    const hasAccess = await checkModuleAccess(userId, courseId, moduleId)
    if (!hasAccess) {
      return next(new AppError('You do not have access to this module', 403))
    }

    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
    }).populate('quiz')

    if (!lesson) {
      return next(new AppError('Lesson not found', 404))
    }

    // Check prerequisites
    const module = await Module.findById(moduleId)
    const prerequisitesMet =
      (await module.prerequisites?.every(async (prereqId) => {
        const progress = await Progress.findOne({
          user: userId,
          module: prereqId,
        })
        return progress?.progress === 100
      })) ?? true

    if (!prerequisitesMet) {
      return next(new AppError('Module prerequisites not met', 403))
    }

    // Check quiz requirements if quiz exists and is required
    if (lesson.quiz && lesson.quizSettings?.required) {
      const quizCompleted = await validateQuizCompletion(userId, lessonId)
      if (!quizCompleted) {
        return next(new AppError('Quiz must be completed first', 403))
      }
    }

    // Update progress
    const progressUpdate = await updateProgress(userId, courseId, moduleId, lessonId, lesson.quiz?._id)

    res.status(200).json({
      status: 'success',
      message: 'Lesson marked as complete',
      data: {
        progress: progressUpdate.progress,
        completedLessons: progressUpdate.completedLessons,
        completedQuizzes: progressUpdate.completedQuizzes,
      },
    })
  } catch (error) {
    next(error)
  }
}

exports.getLessonProgress = async (req, res, next) => {
  try {
    const { courseId, moduleId, lessonId } = req.params
    const userId = req.user._id

    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
    }).populate('quiz')

    if (!lesson) {
      return next(new AppError('Lesson not found', 404))
    }

    // Get all progress records
    const [progress, timeProgress, videoProgress, assetProgress] = await Promise.all([
      Progress.findOne({
        user: userId,
        module: moduleId
      }),
      LessonProgress.findOne({
        user: userId,
        lesson: lessonId
      }),
      lesson.videoUrl ? VideoProgress.findOne({
        user: userId,
        lesson: lessonId
      }) : Promise.resolve(null),
      lesson.assets?.length > 0 ? AssetProgress.find({
        user: userId,
        lesson: lessonId
      }) : Promise.resolve([])
    ])

    const progressData = {
      completed: progress?.completedLessons.includes(lessonId) || false,
      timeSpent: timeProgress?.timeSpent || 0,
      videoProgress: videoProgress ? {
        watchedTime: videoProgress.watchedTime,
        lastPosition: videoProgress.lastPosition,
        completed: videoProgress.completed
      } : null,
      assetProgress: assetProgress.reduce((acc, ap) => {
        acc[ap.asset.toString()] = {
          downloadCount: ap.downloadCount,
          firstDownloaded: ap.firstDownloaded,
          lastDownloaded: ap.lastDownloaded
        }
        return acc
      }, {})
    }

    // Get quiz progress if exists
    if (lesson.quiz) {
      const [quizAttempts, canTakeQuiz] = await Promise.all([
        QuizAttempt.find({
          quiz: lesson.quiz._id,
          user: userId
        }).sort('-submittedAt'),
        checkQuizRequirements(userId, lessonId)
      ])

      progressData.quiz = {
        completed: progress?.completedQuizzes.includes(lesson.quiz._id) || false,
        attempts: quizAttempts.map(attempt => ({
          id: attempt._id,
          score: attempt.score,
          percentage: attempt.percentage,
          passed: attempt.passed,
          status: attempt.status,
          submittedAt: attempt.submittedAt
        })),
        canTake: canTakeQuiz,
        remainingAttempts: lesson.quiz.maxAttempts - quizAttempts.length
      }
    }

    // Get next lesson if available
    const nextLesson = await Lesson.findOne({
      module: moduleId,
      order: lesson.order + 1,
      isDeleted: false,
    }).select('_id title requireQuizPass quizSettings')

    if (nextLesson) {
      progressData.nextLesson = {
        id: nextLesson._id,
        title: nextLesson.title,
        requireQuizPass: nextLesson.requireQuizPass,
        accessible: !nextLesson.quizSettings?.blockProgress || 
          (lesson.quiz ? progress?.completedQuizzes.includes(lesson.quiz._id) : true)
      }
    }

    res.status(200).json({
      status: 'success',
      message: 'Lesson progress retrieved successfully',
      data: progressData
    })
  } catch (error) {
    next(error)
  }
}