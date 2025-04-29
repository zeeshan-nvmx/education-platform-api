const mongoose = require('mongoose')
const { Quiz, QuizAttempt, Lesson, Progress, User, LessonProgress, Module } = require('../models')
const { AppError } = require('../utils/errors')

//Helper functions
async function hasPreviousLessonQuizPassed(userId, moduleId, currentLessonId) {
  try {
    // Get the current lesson to find its order
    const currentLesson = await Lesson.findOne({
      _id: currentLessonId,
      isDeleted: false,
    }).select('order')

    if (!currentLesson) {
      console.log('Current lesson not found, quiz access granted')
      return true // If we can't find current lesson, don't block (safer to debug)
    }

    // Find the immediate previous lesson in the module by order
    const previousLesson = await Lesson.findOne({
      module: moduleId,
      order: { $lt: currentLesson.order },
      isDeleted: false,
    })
      .sort({ order: -1 })
      .populate('quiz')

    // If there's no previous lesson, quiz is automatically takeable
    if (!previousLesson) {
      console.log('No previous lesson found, quiz access granted')
      return true
    }

    // If previous lesson exists but doesn't have a quiz, quiz is automatically takeable
    if (!previousLesson.quiz) {
      console.log('Previous lesson has no quiz, quiz access granted')
      return true
    }

    console.log(`Previous lesson (${previousLesson.title}) has quiz ${previousLesson.quiz._id}, checking if passed`)

    // Get user's progress in this module
    const progress = await Progress.findOne({
      user: userId,
      module: moduleId,
    })

    // If no progress record found, the previous quiz hasn't been passed
    if (!progress) {
      console.log('No progress record found, previous quiz not passed')
      return false
    }

    // Check if the previous lesson's quiz is in the completedQuizzes array
    const previousQuizPassed = progress.completedQuizzes.some((quizId) => quizId.toString() === previousLesson.quiz._id.toString())

    console.log(`Previous quiz passed: ${previousQuizPassed}`)
    return previousQuizPassed
  } catch (error) {
    console.error('Error checking previous lesson quiz:', error)
    return false // Default to not allowing on error for safety
  }
}

exports.createQuiz = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { courseId, moduleId, lessonId } = req.params
    const { title, quizTime, passingScore, questions, maxAttempts = 3, questionPoolSize = 0 } = req.body

    // Validate lesson exists
    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
    }).session(session)

    if (!lesson) {
      await session.abortTransaction()
      return next(new AppError('Lesson not found', 404))
    }

    // Check if quiz already exists
    if (lesson.quiz) {
      await session.abortTransaction()
      return next(new AppError('Quiz already exists for this lesson', 400))
    }

    // Validate questionPoolSize
    if (questionPoolSize > questions.length) {
      await session.abortTransaction()
      return next(new AppError('Question pool size cannot exceed total number of questions', 400))
    }

    // Calculate totalMarks from questions
    const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 1), 0)

    // Create quiz
    const quiz = await Quiz.create(
      [
        {
          lesson: lessonId,
          title,
          quizTime,
          passingScore,
          maxAttempts,
          questionPoolSize,
          totalMarks,
          questions: questions.map((q) => ({
            question: q.question,
            type: q.options ? 'mcq' : 'text',
            options: q.options,
            marks: q.marks || 1,
          })),
        },
      ],
      { session }
    )

    // Update lesson with quiz reference and quiz settings
    lesson.quiz = quiz[0]._id
    lesson.quizSettings = {
      required: true, // Since a quiz is being created
      minimumPassingScore: passingScore,
      allowReview: true,
      blockProgress: true,
      showQuizAt: 'after',
      minimumTimeRequired: 0,
    }

    await lesson.save({ session })

    await session.commitTransaction()

    res.status(201).json({
      status: 'success',
      message: 'Quiz created successfully',
      data: quiz[0],
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

// Update a quiz - Allow admins to update everything regardless of attempts
exports.updateQuiz = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { courseId, moduleId, lessonId } = req.params
    const { title, quizTime, passingScore, questions, maxAttempts, questionPoolSize } = req.body

    // Validate lesson exists and has a quiz
    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
    })
      .populate('quiz')
      .session(session)

    if (!lesson) {
      await session.abortTransaction()
      return next(new AppError('Lesson not found', 404))
    }

    if (!lesson.quiz) {
      await session.abortTransaction()
      return next(new AppError('Quiz not found for this lesson', 404))
    }

    const quiz = lesson.quiz

    // Create update data object with all fields that are provided
    const updateData = {}
    if (title) updateData.title = title
    if (quizTime) updateData.quizTime = quizTime
    if (passingScore) updateData.passingScore = passingScore
    if (maxAttempts) updateData.maxAttempts = maxAttempts

    // Update questions if provided
    if (questions) {
      updateData.questions = questions.map((q) => ({
        question: q.question,
        type: q.options ? 'mcq' : 'text',
        options: q.options,
        marks: q.marks || 1,
      }))

      // Recalculate totalMarks
      updateData.totalMarks = questions.reduce((sum, q) => sum + (q.marks || 1), 0)
    }

    // Update questionPoolSize if provided
    if (questionPoolSize !== undefined) {
      // If updating both questions and pool size
      if (questions) {
        if (questionPoolSize > questions.length && questionPoolSize !== 0) {
          await session.abortTransaction()
          return next(new AppError('Question pool size cannot exceed total number of questions', 400))
        }
        updateData.questionPoolSize = questionPoolSize
      }
      // If only updating pool size (check against existing questions)
      else {
        if (questionPoolSize > quiz.questions.length && questionPoolSize !== 0) {
          await session.abortTransaction()
          return next(new AppError('Question pool size cannot exceed total number of questions', 400))
        }
        updateData.questionPoolSize = questionPoolSize
      }
    }

    // Update the quiz
    const updatedQuiz = await Quiz.findByIdAndUpdate(quiz._id, updateData, { new: true, runValidators: true, session })

    // Update lesson quiz settings if necessary
    if (passingScore) {
      lesson.quizSettings.minimumPassingScore = passingScore
      await lesson.save({ session })
    }

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      message: 'Quiz updated successfully',
      data: updatedQuiz,
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

// Delete a quiz
exports.deleteQuiz = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { courseId, moduleId, lessonId } = req.params

    // Validate lesson exists and has a quiz
    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
    }).session(session)

    if (!lesson) {
      await session.abortTransaction()
      return next(new AppError('Lesson not found', 404))
    }

    if (!lesson.quiz) {
      await session.abortTransaction()
      return next(new AppError('Quiz not found for this lesson', 404))
    }

    const quizId = lesson.quiz

    // Check if there are existing attempts
    const hasAttempts = await QuizAttempt.exists({ quiz: quizId }).session(session)

    if (hasAttempts) {
      // Soft delete - mark quiz as deleted but keep the data
      await Quiz.findByIdAndUpdate(quizId, { isDeleted: true }, { session })
    } else {
      // Hard delete - remove the quiz completely
      await Quiz.findByIdAndDelete(quizId, { session })
    }

    // Always remove the quiz reference from the lesson
    lesson.quiz = undefined
    lesson.quizSettings = {
      required: false,
      minimumPassingScore: 70,
      allowReview: true,
      blockProgress: false,
      showQuizAt: 'after',
      minimumTimeRequired: 0,
    }
    await lesson.save({ session })

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      message: 'Quiz deleted successfully',
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

// exports.getQuiz = async (req, res, next) => {
//   try {
//     const { courseId, moduleId, lessonId } = req.params
//     const userId = req.user._id

//     // Check user has access to this module/course - simplified check
//     const user = await User.findById(userId).select('+role +enrolledCourses').lean()

//     if (!user) {
//       return next(new AppError('User not found', 404))
//     }

//     const isAdmin = ['admin', 'subAdmin', 'moderator'].includes(user.role)
//     let hasAccess = isAdmin

//     if (!isAdmin) {
//       const enrolledCourse = user.enrolledCourses?.find((ec) => ec.course.toString() === courseId)
//       hasAccess = enrolledCourse && (enrolledCourse.enrollmentType === 'full' || enrolledCourse.enrolledModules.some((em) => em.module.toString() === moduleId))
//     }

//     if (!hasAccess) {
//       return next(new AppError('You do not have access to this module', 403))
//     }

//     const lesson = await Lesson.findOne({
//       _id: lessonId,
//       module: moduleId,
//       isDeleted: false,
//     }).populate({
//       path: 'quiz',
//       match: { isDeleted: false },
//     })

//     if (!lesson || !lesson.quiz) {
//       return next(new AppError('Quiz not found', 404))
//     }

//     const quiz = lesson.quiz

//     // Different response based on user role
//     if (isAdmin) {
//       // For admin users, return full quiz data including all questions and correct answers
//       return res.status(200).json({
//         status: 'success',
//         data: {
//           quiz: {
//             _id: quiz._id,
//             title: quiz.title,
//             quizTime: quiz.quizTime,
//             passingScore: quiz.passingScore,
//             maxAttempts: quiz.maxAttempts,
//             totalMarks: quiz.totalMarks,
//             questionPoolSize: quiz.questionPoolSize,
//             questions: quiz.questions, // Include full questions with correct answers
//             createdAt: quiz.createdAt,
//             updatedAt: quiz.updatedAt,
//           },
//           attemptCount: await QuizAttempt.countDocuments({ quiz: quiz._id }),
//           pendingGrading: await QuizAttempt.countDocuments({ quiz: quiz._id, status: 'submitted' }),
//         },
//       })
//     }

//     // For regular users, determine if they can take the quiz
//     let canTakeQuiz = true
//     let blockedReason = null

//     // Time requirement check - Only if specifically set
//     if (lesson.quizSettings?.minimumTimeRequired > 0) {
//       const timeProgress = await LessonProgress.findOne({
//         user: userId,
//         lesson: lessonId,
//       })

//       if (!timeProgress || timeProgress.timeSpent < lesson.quizSettings.minimumTimeRequired * 60) {
//         canTakeQuiz = false
//         blockedReason = `You need to spend at least ${lesson.quizSettings.minimumTimeRequired} minutes on this lesson`
//       }
//     }

//     // Get user's previous attempts
//     const attempts = await QuizAttempt.find({
//       quiz: quiz._id,
//       user: userId,
//     }).sort('-createdAt')

//     // Check if user has reached the maximum attempts
//     const completedAttempts = attempts.filter((attempt) => attempt.status !== 'inProgress')
//     const canStartNewAttempt = canTakeQuiz && completedAttempts.length < quiz.maxAttempts

//     // Check if there are any in-progress attempts
//     const inProgressAttempt = attempts.find((attempt) => attempt.status === 'inProgress')
//     let ongoingAttemptId = null

//     if (inProgressAttempt) {
//       // Check if the attempt has expired based on quiz time
//       const timeLimit = quiz.quizTime * 60 * 1000 // Convert to milliseconds
//       const timeSinceStart = new Date() - inProgressAttempt.startTime

//       if (timeSinceStart <= timeLimit) {
//         // Still valid, provide the attempt ID
//         ongoingAttemptId = inProgressAttempt._id
//       }
//     }

//     // Get progress data for this user and module
//     const progress = await Progress.findOne({
//       user: userId,
//       module: moduleId,
//     })

//     // Check if the quiz has been completed
//     const quizCompleted = progress?.completedQuizzes.some((qId) => qId.toString() === quiz._id.toString()) || false

//     // Return regular user data with improved diagnostic information
//     res.status(200).json({
//       status: 'success',
//       data: {
//         quiz: {
//           _id: quiz._id,
//           title: quiz.title,
//           quizTime: quiz.quizTime,
//           passingScore: quiz.passingScore,
//           maxAttempts: quiz.maxAttempts,
//           totalMarks: quiz.totalMarks,
//           questionCount: quiz.questions.length,
//           questionPoolSize: quiz.questionPoolSize,
//         },
//         attempts: attempts.map((attempt) => ({
//           _id: attempt._id,
//           score: attempt.score,
//           percentage: attempt.percentage,
//           status: attempt.status,
//           startTime: attempt.startTime,
//           submitTime: attempt.submitTime,
//           passed: attempt.passed,
//         })),
//         canTakeQuiz,
//         canStartNewAttempt,
//         ongoingAttemptId,
//         blockedReason,
//         completedAttemptsCount: completedAttempts.length,
//         quizCompleted,
//         requirements: lesson.quizSettings,
//       },
//     })
//   } catch (error) {
//     next(error)
//   }
// }

exports.getQuiz = async (req, res, next) => {
  try {
    const { courseId, moduleId, lessonId } = req.params
    const userId = req.user._id

    // Check user has access to this module/course - simplified check
    const user = await User.findById(userId).select('+role +enrolledCourses').lean()

    if (!user) {
      return next(new AppError('User not found', 404))
    }

    const isAdmin = ['admin', 'subAdmin', 'moderator'].includes(user.role)
    let hasAccess = isAdmin

    if (!isAdmin) {
      const enrolledCourse = user.enrolledCourses?.find((ec) => ec.course.toString() === courseId)
      hasAccess = enrolledCourse && (enrolledCourse.enrollmentType === 'full' || enrolledCourse.enrolledModules.some((em) => em.module.toString() === moduleId))
    }

    if (!hasAccess) {
      return next(new AppError('You do not have access to this module', 403))
    }

    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
    }).populate({
      path: 'quiz',
      match: { isDeleted: false },
    })

    if (!lesson || !lesson.quiz) {
      return next(new AppError('Quiz not found', 404))
    }

    const quiz = lesson.quiz

    // Different response based on user role
    if (isAdmin) {
      // For admin users, return full quiz data including all questions and correct answers
      return res.status(200).json({
        status: 'success',
        data: {
          quiz: {
            _id: quiz._id,
            title: quiz.title,
            quizTime: quiz.quizTime,
            passingScore: quiz.passingScore,
            maxAttempts: quiz.maxAttempts,
            totalMarks: quiz.totalMarks,
            questionPoolSize: quiz.questionPoolSize,
            questions: quiz.questions, // Include full questions with correct answers
            createdAt: quiz.createdAt,
            updatedAt: quiz.updatedAt,
          },
          attemptCount: await QuizAttempt.countDocuments({ quiz: quiz._id }),
          pendingGrading: await QuizAttempt.countDocuments({ quiz: quiz._id, status: 'submitted' }),
        },
      })
    }

    // For regular users, determine if they can take the quiz
    let canTakeQuiz = true
    let blockedReason = null

    // Time requirement check - Only if specifically set
    if (lesson.quizSettings?.minimumTimeRequired > 0) {
      const timeProgress = await LessonProgress.findOne({
        user: userId,
        lesson: lessonId,
      })

      if (!timeProgress || timeProgress.timeSpent < lesson.quizSettings.minimumTimeRequired * 60) {
        canTakeQuiz = false
        blockedReason = `You need to spend at least ${lesson.quizSettings.minimumTimeRequired} minutes on this lesson`
      }
    }

    // Previous lesson quiz check - Only if not already blocked
    if (canTakeQuiz) {
      const previousQuizPassed = await hasPreviousLessonQuizPassed(userId, moduleId, lessonId)

      if (!previousQuizPassed) {
        canTakeQuiz = false
        blockedReason = 'You must pass the quiz in the previous lesson before taking this quiz'
      }
    }

    // Get user's previous attempts
    const attempts = await QuizAttempt.find({
      quiz: quiz._id,
      user: userId,
    }).sort('-createdAt')

    // Check if user has reached the maximum attempts
    const completedAttempts = attempts.filter((attempt) => attempt.status !== 'inProgress')
    const canStartNewAttempt = canTakeQuiz && completedAttempts.length < quiz.maxAttempts

    // Check if there are any in-progress attempts
    const inProgressAttempt = attempts.find((attempt) => attempt.status === 'inProgress')
    let ongoingAttemptId = null

    if (inProgressAttempt) {
      // Check if the attempt has expired based on quiz time
      const timeLimit = quiz.quizTime * 60 * 1000 // Convert to milliseconds
      const timeSinceStart = new Date() - inProgressAttempt.startTime

      if (timeSinceStart <= timeLimit) {
        // Still valid, provide the attempt ID
        ongoingAttemptId = inProgressAttempt._id
      }
    }

    // Get progress data for this user and module
    const progress = await Progress.findOne({
      user: userId,
      module: moduleId,
    })

    // Check if the quiz has been completed
    const quizCompleted = progress?.completedQuizzes.some((qId) => qId.toString() === quiz._id.toString()) || false

    // Return regular user data with improved diagnostic information
    res.status(200).json({
      status: 'success',
      data: {
        quiz: {
          _id: quiz._id,
          title: quiz.title,
          quizTime: quiz.quizTime,
          passingScore: quiz.passingScore,
          maxAttempts: quiz.maxAttempts,
          totalMarks: quiz.totalMarks,
          questionCount: quiz.questions.length,
          questionPoolSize: quiz.questionPoolSize,
        },
        attempts: attempts.map((attempt) => ({
          _id: attempt._id,
          score: attempt.score,
          percentage: attempt.percentage,
          status: attempt.status,
          startTime: attempt.startTime,
          submitTime: attempt.submitTime,
          passed: attempt.passed,
        })),
        canTakeQuiz,
        canStartNewAttempt,
        ongoingAttemptId,
        blockedReason,
        completedAttemptsCount: completedAttempts.length,
        quizCompleted,
        requirements: lesson.quizSettings,
      },
    })
  } catch (error) {
    next(error)
  }
}

// // Get all ungraded text-based quiz submissions
// exports.getUngradedSubmissions = async (req, res, next) => {
//   try {
//     // Get the optional parameters (they'll be undefined if not provided)
//     const { courseId, moduleId, lessonId } = req.params;
    
//     // Basic query for all ungraded attempts
//     const query = { status: 'submitted' };
    
//     // Get all ungraded attempts with text answers
//     const ungradedAttempts = await QuizAttempt.find(query)
//       .populate({
//         path: 'quiz',
//         select: 'title lesson',
//         populate: {
//           path: 'lesson',
//           select: 'title module',
//           match: { isDeleted: false }
//         }
//       })
//       .populate({
//         path: 'user',
//         select: 'firstName lastName email'
//       })
//       .sort('-submittedAt')
//       .lean();
    
//     // Filter in memory if course/module/lesson IDs are provided
//     let filteredAttempts = ungradedAttempts;
    
//     if (moduleId) {
//       filteredAttempts = filteredAttempts.filter(attempt => 
//         attempt.quiz?.lesson?.module?.toString() === moduleId
//       );
//     }
    
//     if (courseId) {
//       // Get all modules in this course
//       const moduleIds = await Module.find({ 
//         course: courseId, 
//         isDeleted: false 
//       }).distinct('_id');
      
//       // Convert ObjectIds to strings for comparison
//       const moduleIdStrings = moduleIds.map(id => id.toString());
      
//       // Filter attempts by course's modules
//       filteredAttempts = filteredAttempts.filter(attempt => 
//         moduleIdStrings.includes(attempt.quiz?.lesson?.module?.toString())
//       );
//     }
    
//     if (lessonId) {
//       filteredAttempts = filteredAttempts.filter(attempt => 
//         attempt.quiz?.lesson?._id?.toString() === lessonId
//       );
//     }
    
//     // Format the response with useful information
//     const formattedAttempts = filteredAttempts.map(attempt => ({
//       attemptId: attempt._id,
//       quiz: {
//         id: attempt.quiz?._id,
//         title: attempt.quiz?.title
//       },
//       lesson: {
//         id: attempt.quiz?.lesson?._id,
//         title: attempt.quiz?.lesson?.title,
//         module: attempt.quiz?.lesson?.module
//       },
//       user: {
//         id: attempt.user?._id,
//         name: `${attempt.user?.firstName} ${attempt.user?.lastName}`,
//         email: attempt.user?.email
//       },
//       submittedAt: attempt.submittedAt || attempt.updatedAt,
//       textQuestions: attempt.answers
//         .filter(answer => !answer.hasOwnProperty('selectedOption'))
//         .length
//     }));
    
//     res.status(200).json({
//       status: 'success',
//       count: formattedAttempts.length,
//       data: formattedAttempts
//     });
//   } catch (error) {
//     next(error);
//   }
// }

exports.getUngradedSubmissions = async (req, res, next) => {
  try {
    // Get the optional parameters (they'll be undefined if not provided)
    const { courseId, moduleId, lessonId } = req.params

    // Query for submissions that need manual grading (status: 'submitted')
    const query = { status: 'submitted' }

    // Get all ungraded attempts
    const ungradedAttempts = await QuizAttempt.find(query)
      .populate({
        path: 'quiz',
        select: 'title lesson questions',
        populate: {
          path: 'lesson',
          select: 'title module',
          match: { isDeleted: false },
        },
      })
      .populate({
        path: 'user',
        select: 'firstName lastName email',
      })
      .sort('-submittedAt')
      .lean()

    // Filter to only include attempts with text questions that need grading
    const attemptsWithTextQuestions = ungradedAttempts.filter((attempt) => {
      // Only keep attempts that have at least one text answer
      return attempt.answers.some(
        (answer) =>
          // Text answers have textAnswer property but no selectedOption property
          answer.textAnswer && !answer.hasOwnProperty('selectedOption')
      )
    })

    // Apply additional filters if course/module/lesson IDs are provided
    let filteredAttempts = attemptsWithTextQuestions

    if (moduleId) {
      filteredAttempts = filteredAttempts.filter((attempt) => attempt.quiz?.lesson?.module?.toString() === moduleId)
    }

    if (courseId) {
      // Get all modules in this course
      const moduleIds = await Module.find({
        course: courseId,
        isDeleted: false,
      }).distinct('_id')

      // Convert ObjectIds to strings for comparison
      const moduleIdStrings = moduleIds.map((id) => id.toString())

      // Filter attempts by course's modules
      filteredAttempts = filteredAttempts.filter((attempt) => moduleIdStrings.includes(attempt.quiz?.lesson?.module?.toString()))
    }

    if (lessonId) {
      filteredAttempts = filteredAttempts.filter((attempt) => attempt.quiz?.lesson?._id?.toString() === lessonId)
    }

    // Format the response with useful information
    const formattedAttempts = filteredAttempts.map((attempt) => {
      // Count text questions that need grading
      const textQuestionsCount = attempt.answers.filter((answer) => answer.textAnswer && !answer.hasOwnProperty('selectedOption')).length

      return {
        attemptId: attempt._id,
        quiz: {
          id: attempt.quiz?._id,
          title: attempt.quiz?.title,
        },
        lesson: {
          id: attempt.quiz?.lesson?._id,
          title: attempt.quiz?.lesson?.title,
          module: attempt.quiz?.lesson?.module,
        },
        user: {
          id: attempt.user?._id,
          name: `${attempt.user?.firstName} ${attempt.user?.lastName}`,
          email: attempt.user?.email,
        },
        submittedAt: attempt.submittedAt || attempt.updatedAt,
        textQuestionsCount: textQuestionsCount,
        // Include the text answers that need grading
        textAnswers: attempt.answers
          .filter((answer) => answer.textAnswer && !answer.hasOwnProperty('selectedOption'))
          .map((answer) => ({
            questionId: answer.questionId,
            textAnswer: answer.textAnswer,
          })),
      }
    })

    res.status(200).json({
      status: 'success',
      message: 'Ungraded submissions fetched successfully',
      count: formattedAttempts.length,
      data: formattedAttempts,
    })
  } catch (error) {
    next(error)
  }
}

// Get notifications for graded quizzes
exports.getQuizNotifications = async (req, res, next) => {
  try {
    const userId = req.user._id;
    
    // Find recently graded attempts for this user
    // That haven't been viewed yet
    const recentlyGradedAttempts = await QuizAttempt.find({
      user: userId,
      status: 'graded',
      // You could add a field to track if notifications have been viewed
      // notificationViewed: { $ne: true }
    })
    .populate({
      path: 'quiz',
      select: 'title lesson',
      populate: {
        path: 'lesson',
        select: 'title'
      }
    })
    .populate({
      path: 'gradedBy',
      select: 'firstName lastName'
    })
    .sort('-updatedAt')  // Most recently graded first
    .limit(10)  // Limit to last 10 graded attempts
    .lean();
    
    // Format the notifications
    const notifications = recentlyGradedAttempts.map(attempt => ({
      attemptId: attempt._id,
      quizId: attempt.quiz._id,
      quizTitle: attempt.quiz.title,
      lessonId: attempt.quiz.lesson._id,
      lessonTitle: attempt.quiz.lesson.title,
      score: attempt.score,
      percentage: attempt.percentage,
      passed: attempt.passed,
      gradedAt: attempt.updatedAt,
      gradedBy: attempt.gradedBy ? 
        `${attempt.gradedBy.firstName} ${attempt.gradedBy.lastName}` : 
        'System'
    }));
    
    res.status(200).json({
      status: 'success',
      message: 'Quiz notifications fetched successfully',
      count: notifications.length,
      data: notifications
    });
  } catch (error) {
    next(error);
  }
}

// Mark notifications as viewed
exports.markNotificationsViewed = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { attemptIds } = req.body;
    
    if (!attemptIds || !Array.isArray(attemptIds) || !attemptIds.length) {
      return next(new AppError('Please provide attempt IDs to mark as viewed', 400));
    }
    
    // Update attempts to set notification as viewed
    await QuizAttempt.updateMany(
      { 
        _id: { $in: attemptIds }, 
        user: userId 
      },
      { 
        $set: { notificationViewed: true } 
      }
    );
    
    res.status(200).json({
      status: 'success',
      message: `${attemptIds.length} notifications marked as viewed`
    });
  } catch (error) {
    next(error);
  }
};

exports.startQuiz = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { courseId, moduleId, lessonId } = req.params
    const userId = req.user._id

    // Check user has access to this module/course - simplified check
    const user = await User.findById(userId).select('+role +enrolledCourses').lean().session(session)

    if (!user) {
      await session.abortTransaction()
      return next(new AppError('User not found', 404))
    }

    const isAdmin = ['admin', 'subAdmin', 'moderator'].includes(user.role)
    let hasAccess = isAdmin

    if (!isAdmin) {
      const enrolledCourse = user.enrolledCourses?.find((ec) => ec.course.toString() === courseId)
      hasAccess = enrolledCourse && (enrolledCourse.enrollmentType === 'full' || enrolledCourse.enrolledModules.some((em) => em.module.toString() === moduleId))
    }

    if (!hasAccess) {
      await session.abortTransaction()
      return next(new AppError('You do not have access to this module', 403))
    }

    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
    })
      .populate({
        path: 'quiz',
        match: { isDeleted: false },
      })
      .session(session)

    if (!lesson || !lesson.quiz) {
      await session.abortTransaction()
      return next(new AppError('Quiz not found', 404))
    }

    const quiz = lesson.quiz

    // Skip all checks for admin users
    if (!isAdmin) {
      // Time requirement check - only if it's actually set (greater than 0)
      if (lesson.quizSettings?.minimumTimeRequired > 0) {
        const timeProgress = await LessonProgress.findOne({
          user: userId,
          lesson: lessonId,
        }).session(session)

        if (!timeProgress || timeProgress.timeSpent < lesson.quizSettings.minimumTimeRequired * 60) {
          await session.abortTransaction()
          return next(new AppError(`You need to spend at least ${lesson.quizSettings.minimumTimeRequired} minutes on this lesson before taking the quiz`, 403))
        }
      }
    }

    // Get all attempts including inProgress ones
    const allAttempts = await QuizAttempt.find({
      quiz: quiz._id,
      user: userId,
    })
      .sort('-createdAt')
      .session(session)

    // Split attempts by status
    const inProgressAttempts = allAttempts.filter((attempt) => attempt.status === 'inProgress')
    const completedAttempts = allAttempts.filter((attempt) => attempt.status !== 'inProgress')

    // Check if max attempts reached - skip for admin users
    if (!isAdmin && completedAttempts.length >= quiz.maxAttempts) {
      await session.abortTransaction()
      return next(new AppError(`Maximum attempts (${quiz.maxAttempts}) reached`, 400))
    }

    // Step 1: Process expired attempts - mark them as submitted with zero score
    for (const attempt of inProgressAttempts) {
      const timeLimit = quiz.quizTime * 60 * 1000 // Convert to milliseconds
      const timeSinceStart = new Date() - attempt.startTime

      if (timeSinceStart > timeLimit) {
        // This attempt has expired, mark it as submitted with zero score
        attempt.status = 'submitted'
        attempt.submitTime = new Date(attempt.startTime.getTime() + timeLimit)
        attempt.score = 0
        attempt.percentage = 0
        attempt.passed = false
        await attempt.save({ session })
      } else {
        // Still valid attempt within time window
        await session.abortTransaction()
        return next(new AppError('You have an ongoing quiz attempt', 400))
      }
    }

    // Step 2: At this point all in-progress attempts are either expired (and marked as submitted)
    // or we've returned an error for valid in-progress attempts

    // Step 3: Find highest attempt number across all attempts (both completed and previously in-progress)
    // Re-query to get the updated status of attempts after marking expired ones
    const updatedAttempts = await QuizAttempt.find({
      quiz: quiz._id,
      user: userId,
    }).session(session)

    // Find the highest attempt number
    let highestAttemptNumber = 0
    if (updatedAttempts.length > 0) {
      highestAttemptNumber = Math.max(...updatedAttempts.map((a) => a.attempt))
    }

    // Use next available attempt number
    const nextAttemptNumber = highestAttemptNumber + 1

    // Determine question set based on questionPoolSize
    let questionSet = [...quiz.questions]
    let selectedQuestionIds = []

    // If questionPoolSize is set and less than total questions, select random subset
    if (quiz.questionPoolSize > 0 && quiz.questionPoolSize < quiz.questions.length) {
      // Shuffle questions array
      questionSet = quiz.questions
        .map((q) => ({ q, sort: Math.random() }))
        .sort((a, b) => a.sort - b.sort)
        .map(({ q }) => q)
        .slice(0, quiz.questionPoolSize)
    }

    // Extract just the question IDs for storing in the attempt
    selectedQuestionIds = questionSet.map((q) => q._id)

    // Create new attempt with the selected question set
    const attempt = await QuizAttempt.create(
      [
        {
          quiz: quiz._id,
          user: userId,
          attempt: nextAttemptNumber,
          startTime: new Date(),
          questionSet: selectedQuestionIds,
        },
      ],
      { session }
    )

    // Prepare questions (remove correct answers for MCQs)
    const questions = questionSet.map((q) => ({
      _id: q._id,
      question: q.question,
      type: q.type,
      marks: q.marks,
      options:
        q.type === 'mcq'
          ? q.options.map((opt) => ({
              _id: opt._id,
              option: opt.option,
            }))
          : undefined,
    }))

    await session.commitTransaction()

    // Calculate total marks for the selected questions
    const attemptTotalMarks = questionSet.reduce((sum, q) => sum + q.marks, 0)

    res.status(200).json({
      status: 'success',
      data: {
        attemptId: attempt[0]._id,
        questions,
        questionCount: questions.length,
        totalMarks: attemptTotalMarks,
        quizTime: quiz.quizTime,
        startTime: attempt[0].startTime,
      },
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.submitQuiz = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { courseId, moduleId, lessonId, attemptId } = req.params
    const { answers } = req.body
    const userId = req.user._id

    // Get attempt and quiz
    const attempt = await QuizAttempt.findOne({
      _id: attemptId,
      user: userId,
      status: 'inProgress',
    }).session(session)

    if (!attempt) {
      await session.abortTransaction()
      return next(new AppError('Quiz attempt not found or already submitted', 404))
    }

    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
    })
      .populate('quiz')
      .session(session)

    if (!lesson || !lesson.quiz) {
      await session.abortTransaction()
      return next(new AppError('Quiz not found', 404))
    }

    const quiz = lesson.quiz

    // Check time limit
    const timeLimit = quiz.quizTime * 60 * 1000 // Convert to milliseconds
    const timeTaken = new Date() - attempt.startTime

    if (timeTaken > timeLimit) {
      await session.abortTransaction()
      return next(new AppError('Quiz time limit exceeded', 400))
    }

    // Process answers and calculate score
    let totalScore = 0
    let totalPossibleMarks = 0
    const processedAnswers = []
    let needsManualGrading = false

    // Get the set of questions for this attempt
    const questionSet = attempt.questionSet || []
    const questionsMap = {}

    // Create a map of question ID to question for quick lookup
    quiz.questions.forEach((q) => {
      questionsMap[q._id.toString()] = q
    })

    for (const answer of answers) {
      // Skip answers for questions not in this attempt's question set
      if (!questionSet.includes(answer.questionId) && !questionSet.some((qId) => qId.toString() === answer.questionId.toString())) {
        continue
      }

      const question = questionsMap[answer.questionId.toString()]
      if (!question) continue

      totalPossibleMarks += question.marks

      const processedAnswer = {
        questionId: answer.questionId,
        marks: 0,
      }

      if (question.type === 'mcq') {
        // Handle MCQ
        const correctOption = question.options.find((opt) => opt.isCorrect)
        processedAnswer.selectedOption = answer.selectedOption
        processedAnswer.isCorrect = correctOption && correctOption.option === answer.selectedOption
        processedAnswer.marks = processedAnswer.isCorrect ? question.marks : 0
        totalScore += processedAnswer.marks
      } else {
        // Handle text answer
        processedAnswer.textAnswer = answer.textAnswer
        needsManualGrading = true
      }

      processedAnswers.push(processedAnswer)
    }

    // Update attempt
    attempt.answers = processedAnswers
    attempt.submitTime = new Date()
    attempt.status = needsManualGrading ? 'submitted' : 'graded'

    if (!needsManualGrading) {
      attempt.score = totalScore
      attempt.percentage = totalPossibleMarks > 0 ? (totalScore / totalPossibleMarks) * 100 : 0
      attempt.passed = attempt.percentage >= quiz.passingScore
    }

    await attempt.save({ session })

    // If passed, update progress
    if (!needsManualGrading && attempt.percentage >= quiz.passingScore) {
      // Get or create user's progress record
      let progress = await Progress.findOne({
        user: userId,
        course: courseId,
        module: moduleId,
      }).session(session)

      if (!progress) {
        progress = new Progress({
          user: userId,
          course: courseId,
          module: moduleId,
          completedLessons: [],
          completedQuizzes: [],
          progress: 0,
          lastAccessed: new Date(),
        })
      }

      // Use string comparison for IDs
      const completedLessonIds = progress.completedLessons.map((id) => id.toString())
      if (!completedLessonIds.includes(lessonId)) {
        progress.completedLessons.push(lessonId)
      }

      const completedQuizIds = progress.completedQuizzes.map((id) => id.toString())
      if (!completedQuizIds.includes(quiz._id.toString())) {
        progress.completedQuizzes.push(quiz._id)
      }

      // Update progress percentage
      const totalLessons = await Lesson.countDocuments({
        module: moduleId,
        isDeleted: false,
      }).session(session)

      if (totalLessons > 0) {
        progress.progress = (progress.completedLessons.length / totalLessons) * 100
      }

      await progress.save({ session })

      // Also update LessonProgress specifically for this lesson if you're using it
      let lessonProgress = await LessonProgress.findOne({
        user: userId,
        lesson: lessonId,
      }).session(session)

      if (lessonProgress) {
        lessonProgress.completed = true
        await lessonProgress.save({ session })
      }
    }

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      data: {
        score: attempt.score,
        percentage: attempt.percentage,
        passed: attempt.passed,
        needsManualGrading,
        answers: processedAnswers,
        lessonCompleted: !needsManualGrading && attempt.percentage >= quiz.passingScore,
      },
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

// Grade text answers (admin/moderator only)
// exports.gradeQuiz = async (req, res, next) => {
//   const session = await mongoose.startSession()
//   session.startTransaction()

//   try {
//     const { courseId, moduleId, lessonId, attemptId } = req.params
//     const { grades } = req.body

//     const attempt = await QuizAttempt.findOne({
//       _id: attemptId,
//       status: 'submitted',
//     }).session(session)

//     if (!attempt) {
//       await session.abortTransaction()
//       return next(new AppError('Quiz attempt not found or already graded', 404))
//     }

//     const lesson = await Lesson.findOne({
//       _id: lessonId,
//       module: moduleId,
//       isDeleted: false,
//     })
//       .populate({
//         path: 'quiz',
//         match: { isDeleted: false },
//       })
//       .session(session)

//     if (!lesson || !lesson.quiz) {
//       await session.abortTransaction()
//       return next(new AppError('Quiz not found', 404))
//     }

//     const quiz = lesson.quiz

//     // Process grades
//     let totalScore = 0

//     for (const answer of attempt.answers) {
//       const grade = grades.find((g) => g.questionId.toString() === answer.questionId.toString())
//       const question = quiz.questions.id(answer.questionId)

//       if (grade && question) {
//         answer.marks = Math.min(grade.marks, question.marks)
//         answer.feedback = grade.feedback
//         totalScore += answer.marks
//       } else if (answer.isCorrect) {
//         // Keep the score for autocorrected MCQ answers
//         totalScore += answer.marks
//       }
//     }

//     // Update attempt
//     attempt.score = totalScore
//     attempt.percentage = (totalScore / quiz.totalMarks) * 100
//     attempt.passed = attempt.percentage >= quiz.passingScore
//     attempt.status = 'graded'
//     attempt.gradedBy = req.user._id

//     await attempt.save({ session })

//     // Update progress if passed
//     if (attempt.percentage >= quiz.passingScore) {
//       let progress = await Progress.findOne({
//         user: attempt.user,
//         course: courseId,
//         module: moduleId,
//       }).session(session)

//       if (!progress) {
//         progress = new Progress({
//           user: attempt.user,
//           course: courseId,
//           module: moduleId,
//           completedLessons: [],
//           completedQuizzes: [],
//           progress: 0,
//           lastAccessed: new Date(),
//         })
//       }

//       if (!progress.completedQuizzes.includes(quiz._id)) {
//         progress.completedQuizzes.push(quiz._id)
//         await progress.save({ session })
//       }
//     }

//     await session.commitTransaction()

//     res.status(200).json({
//       status: 'success',
//       data: {
//         score: attempt.score,
//         percentage: attempt.percentage,
//         passed: attempt.passed,
//         answers: attempt.answers,
//       },
//     })
//   } catch (error) {
//     await session.abortTransaction()
//     next(error)
//   } finally {
//     session.endSession()
//   }
// }

exports.gradeQuiz = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { courseId, moduleId, lessonId, attemptId } = req.params
    const { grades } = req.body

    const attempt = await QuizAttempt.findOne({
      _id: attemptId,
      status: 'submitted',
    }).session(session)

    if (!attempt) {
      await session.abortTransaction()
      return next(new AppError('Quiz attempt not found or already graded', 404))
    }

    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
    })
      .populate({
        path: 'quiz',
        match: { isDeleted: false },
      })
      .session(session)

    if (!lesson || !lesson.quiz) {
      await session.abortTransaction()
      return next(new AppError('Quiz not found', 404))
    }

    const quiz = lesson.quiz

    // Process grades
    let totalScore = 0

    for (const answer of attempt.answers) {
      const grade = grades.find((g) => g.questionId.toString() === answer.questionId.toString())
      const question = quiz.questions.id(answer.questionId)

      if (grade && question) {
        answer.marks = Math.min(grade.marks, question.marks)
        answer.feedback = grade.feedback
        totalScore += answer.marks
      } else if (answer.isCorrect) {
        // Keep the score for autocorrected MCQ answers
        totalScore += answer.marks
      }
    }

    // Update attempt
    attempt.score = totalScore
    attempt.percentage = (totalScore / quiz.totalMarks) * 100
    attempt.passed = attempt.percentage >= quiz.passingScore
    attempt.status = 'graded'
    attempt.gradedBy = req.user._id
    attempt.gradedAt = new Date()
    attempt.notificationSent = false // Track if email notification was sent

    await attempt.save({ session })

    // Update progress if passed
    if (attempt.percentage >= quiz.passingScore) {
      let progress = await Progress.findOne({
        user: attempt.user,
        course: courseId,
        module: moduleId,
      }).session(session)

      if (!progress) {
        progress = new Progress({
          user: attempt.user,
          course: courseId,
          module: moduleId,
          completedLessons: [],
          completedQuizzes: [],
          progress: 0,
          lastAccessed: new Date(),
        })
      }

      // Add lesson to completedLessons if not already there
      const completedLessonIds = progress.completedLessons.map((id) => id.toString())
      if (!completedLessonIds.includes(lessonId)) {
        progress.completedLessons.push(lessonId)
      }

      // Add quiz to completedQuizzes if not already there
      const completedQuizIds = progress.completedQuizzes.map((id) => id.toString())
      if (!completedQuizIds.includes(quiz._id.toString())) {
        progress.completedQuizzes.push(quiz._id)
      }

      // Update progress percentage
      const totalLessons = await Lesson.countDocuments({
        module: moduleId,
        isDeleted: false,
      }).session(session)

      if (totalLessons > 0) {
        progress.progress = (progress.completedLessons.length / totalLessons) * 100
      }

      await progress.save({ session })
    }

    await session.commitTransaction()

    // Get the user for email notification
    const user = await User.findById(attempt.user)

    // Send email notification asynchronously (don't await it)
    if (user && user.email) {
      const emailService = require('../utils/email')
      emailService
        .sendQuizGradedEmail(user.email, `${user.firstName} ${user.lastName}`, quiz.title, lesson.title, attempt.score, attempt.percentage, attempt.passed)
        .then((success) => {
          // Update notification status after email is sent
          if (success) {
            QuizAttempt.findByIdAndUpdate(attempt._id, { notificationSent: true }).exec()
          }
        })
        .catch((err) => {
          console.error('Error sending quiz graded email:', err)
        })
    }

    res.status(200).json({
      status: 'success',
      data: {
        score: attempt.score,
        percentage: attempt.percentage,
        passed: attempt.passed,
        answers: attempt.answers,
      },
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

// Controller function to get a single quiz attempt
exports.getQuizAttemptById = async (req, res, next) => {
  try {
    const { attemptId } = req.params;
    
    // Find the attempt with populated data
    const attempt = await QuizAttempt.findById(attemptId)
      .populate({
        path: 'quiz',
        select: 'title lesson questions totalMarks',
        populate: {
          path: 'lesson',
          select: 'title module',
          populate: {
            path: 'module',
            select: 'title course',
            populate: {
              path: 'course',
              select: 'title'
            }
          }
        }
      })
      .populate({
        path: 'user',
        select: 'firstName lastName email'
      })
      .populate({
        path: 'gradedBy',
        select: 'firstName lastName'
      });
    
    if (!attempt) {
      return next(new AppError('Quiz attempt not found', 404));
    }
    
    // Check if user has permission
    const userId = req.user._id;
    const isAdmin = ['admin', 'subAdmin', 'moderator'].includes(req.user.role);
    
    // Only allow the user who took the quiz or admins to view the attempt
    if (!isAdmin && attempt.user._id.toString() !== userId.toString()) {
      return next(new AppError('You do not have permission to view this attempt', 403));
    }
    
    // Prepare the questions with answers
    const questionsWithAnswers = [];
    
    // Map answers to their respective questions
    for (const question of attempt.quiz.questions) {
      // Find the answer for this question
      const answer = attempt.answers.find(a => 
        a.questionId.toString() === question._id.toString()
      );
      
      questionsWithAnswers.push({
        questionId: question._id,
        question: question.question,
        type: question.type,
        marks: question.marks,
        maxMarks: question.marks,
        userAnswer: {
          selectedOption: answer?.selectedOption,
          textAnswer: answer?.textAnswer,
          marks: answer?.marks,
          feedback: answer?.feedback,
          isCorrect: answer?.isCorrect
        },
        options: question.type === 'mcq' ? 
          // Admin can see correct answers
          (isAdmin ? question.options : 
            // Regular users only see options without correct answers
            question.options.map(opt => ({
              _id: opt._id,
              option: opt.option
            }))) 
          : undefined
      });
    }
    
    // Format the response
    const result = {
      attemptId: attempt._id,
      quiz: {
        id: attempt.quiz._id,
        title: attempt.quiz.title,
        totalMarks: attempt.quiz.totalMarks
      },
      lesson: {
        id: attempt.quiz.lesson._id,
        title: attempt.quiz.lesson.title
      },
      module: {
        id: attempt.quiz.lesson.module._id,
        title: attempt.quiz.lesson.module.title
      },
      course: {
        id: attempt.quiz.lesson.module.course._id,
        title: attempt.quiz.lesson.module.course.title
      },
      user: {
        id: attempt.user._id,
        name: `${attempt.user.firstName} ${attempt.user.lastName}`,
        email: attempt.user.email
      },
      score: attempt.score,
      percentage: attempt.percentage,
      passed: attempt.passed,
      status: attempt.status,
      startTime: attempt.startTime,
      submitTime: attempt.submitTime,
      gradedBy: attempt.gradedBy ? 
        `${attempt.gradedBy.firstName} ${attempt.gradedBy.lastName}` : 
        undefined,
      questions: questionsWithAnswers
    };
    
    res.status(200).json({
      status: 'success',
      message: 'Quiz attempt fetched successfully',
      data: result
    });
  } catch (error) {
    next(error);
  }
};

// Get quiz results
exports.getQuizResults = async (req, res, next) => {
  try {
    const { courseId, moduleId, lessonId, attemptId } = req.params
    const userId = req.user._id

    // Check user has access to this module/course - simplified check
    const user = await User.findById(userId).select('+role +enrolledCourses').lean()

    if (!user) {
      return next(new AppError('User not found', 404))
    }

    const isAdmin = ['admin', 'subAdmin', 'moderator'].includes(user.role)
    let hasAccess = isAdmin

    if (!isAdmin) {
      const enrolledCourse = user.enrolledCourses?.find((ec) => ec.course.toString() === courseId)
      hasAccess = enrolledCourse && (enrolledCourse.enrollmentType === 'full' || enrolledCourse.enrolledModules.some((em) => em.module.toString() === moduleId))
    }

    if (!hasAccess) {
      return next(new AppError('You do not have access to this module', 403))
    }

    const attempt = await QuizAttempt.findOne({
      _id: attemptId,
      user: userId,
    }).populate('quiz')

    if (!attempt) {
      return next(new AppError('Quiz attempt not found', 404))
    }

    const lesson = await Lesson.findById(lessonId).select('quizSettings')

    // Check if review is allowed
    if (!lesson.quizSettings.allowReview) {
      return next(new AppError('Quiz review is not allowed', 403))
    }

    // Prepare results with correct answers
    const results = {
      score: attempt.score,
      percentage: attempt.percentage,
      passed: attempt.passed,
      status: attempt.status,
      startTime: attempt.startTime,
      submitTime: attempt.submitTime,
      answers: attempt.answers.map((answer) => {
        const question = attempt.quiz.questions.id(answer.questionId)
        return {
          question: question.question,
          type: question.type,
          marks: answer.marks,
          maxMarks: question.marks,
          selectedOption: answer.selectedOption,
          textAnswer: answer.textAnswer,
          feedback: answer.feedback,
          correctOption: question.type === 'mcq' && lesson.quizSettings.allowReview ? question.options.find((opt) => opt.isCorrect)?.option : undefined,
        }
      }),
    }

    res.status(200).json({
      status: 'success',
      data: results,
    })
  } catch (error) {
    next(error)
  }
}

exports.resetUserAttempts = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { courseId, moduleId, lessonId } = req.params
    const { userId } = req.body

    if (!userId) {
      await session.abortTransaction()
      return next(new AppError('User ID is required', 400))
    }

    // Validate lesson exists and has a quiz
    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
    })
      .populate('quiz')
      .session(session)

    if (!lesson || !lesson.quiz) {
      await session.abortTransaction()
      return next(new AppError('Quiz not found', 404))
    }

    const quiz = lesson.quiz

    // Check if user exists
    const user = await User.findById(userId).session(session)
    if (!user) {
      await session.abortTransaction()
      return next(new AppError('User not found', 404))
    }

    // Get attempt count before deletion
    const attemptCount = await QuizAttempt.countDocuments({
      quiz: quiz._id,
      user: userId,
    }).session(session)

    if (attemptCount === 0) {
      await session.abortTransaction()
      return next(new AppError('No attempts found for this user', 404))
    }

    // Delete all attempts for this user and quiz
    await QuizAttempt.deleteMany({
      quiz: quiz._id,
      user: userId,
    }).session(session)

    // Remove this quiz from user's completed quizzes
    await Progress.updateOne({ user: userId, course: courseId, module: moduleId }, { $pull: { completedQuizzes: quiz._id } }).session(session)

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      message: `Successfully reset ${attemptCount} attempts for user`,
      data: {
        userId,
        quizId: quiz._id,
        attemptsReset: attemptCount,
      },
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}
