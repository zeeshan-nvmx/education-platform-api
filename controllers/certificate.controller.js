const mongoose = require('mongoose')
const { Course, Module, User, Lesson, Progress, Certificate } = require('../models')
const { AppError } = require('../utils/errors')
const crypto = require('crypto')

// Generate a short, unique certificate ID (max 10 chars, uppercase)
function generateCertificateId(type) {
  // Use 'C' prefix for course, 'M' for module
  const prefix = type === 'course' ? 'C' : 'M'

  // Generate random bytes and convert to base36 string
  const randomBytes = crypto.randomBytes(4).toString('hex').toUpperCase().substring(0, 8)

  // Combine prefix and random string, ensuring total length ≤ 10
  return `${prefix}${randomBytes}`.substring(0, 10)
}

// Verify if a certificate ID exists
exports.verifyCertificate = async (req, res, next) => {
  try {
    const { certificateId } = req.params

    // Find certificate in database
    const certificate = await Certificate.findOne({
      certificateId: certificateId.toUpperCase(),
      isRevoked: false,
    })

    if (!certificate) {
      return next(new AppError('Certificate not found or has been revoked', 404))
    }

    // Return certificate data
    res.status(200).json({
      status: 'success',
      message: 'Certificate verified successfully',
      data: certificate,
    })
  } catch (error) {
    next(error)
  }
}

// Get certificate data for a completed course
exports.getCourseCertificate = async (req, res, next) => {
  try {
    const { courseId } = req.params
    const userId = req.user._id

    const certificateData = await getCourseCompletionData(userId, courseId)

    if (!certificateData.isCompleted) {
      return next(new AppError('Course not yet completed. All modules must be completed to generate a certificate.', 400))
    }

    // Check if a certificate already exists
    let certificate = await Certificate.findOne({
      user: userId,
      course: courseId,
      certificateType: 'course',
      isRevoked: false,
    })

    // If certificate exists, use it
    if (certificate) {
      certificateData.certificateId = certificate.certificateId
      certificateData.issueDate = certificate.issueDate

      res.status(200).json({
        status: 'success',
        message: 'Existing certificate retrieved successfully',
        data: certificateData,
      })
      return
    }

    // Generate a certificate ID for new certificate
    const certificateId = generateCertificateId('course')
    certificateData.certificateId = certificateId

    // Save certificate to database
    certificate = await Certificate.create({
      certificateId,
      certificateType: 'course',
      user: userId,
      course: courseId,
      courseTitle: certificateData.courseTitle,
      studentName: certificateData.studentName,
      completionDate: certificateData.completionDate,
      issueDate: new Date(),
      metadata: {
        category: certificateData.category,
        totalModules: certificateData.totalModules,
        completedModules: certificateData.completedModules,
        instructors: certificateData.instructors,
        creatorName: certificateData.creatorName,
      },
    })

    res.status(200).json({
      status: 'success',
      message: 'Certificate data generated successfully',
      data: certificateData,
    })
  } catch (error) {
    next(error)
  }
}

// Get certificate data for a completed module
exports.getModuleCertificate = async (req, res, next) => {
  try {
    const { courseId, moduleId } = req.params
    const userId = req.user._id

    const certificateData = await getModuleCompletionData(userId, courseId, moduleId)

    if (!certificateData.isCompleted) {
      return next(new AppError('Module not yet completed. All lessons must be completed to generate a certificate.', 400))
    }

    // Check if a certificate already exists
    let certificate = await Certificate.findOne({
      user: userId,
      course: courseId,
      module: moduleId,
      certificateType: 'module',
      isRevoked: false,
    })

    // If certificate exists, use it
    if (certificate) {
      certificateData.certificateId = certificate.certificateId
      certificateData.issueDate = certificate.issueDate

      res.status(200).json({
        status: 'success',
        message: 'Existing certificate retrieved successfully',
        data: certificateData,
      })
      return
    }

    // Generate a certificate ID for new certificate
    const certificateId = generateCertificateId('module')
    certificateData.certificateId = certificateId

    // Save certificate to database
    certificate = await Certificate.create({
      certificateId,
      certificateType: 'module',
      user: userId,
      course: courseId,
      module: moduleId,
      courseTitle: certificateData.courseTitle,
      moduleTitle: certificateData.moduleTitle,
      studentName: certificateData.studentName,
      completionDate: certificateData.completionDate,
      issueDate: new Date(),
      metadata: {
        category: certificateData.category,
        totalLessons: certificateData.totalLessons,
        completedLessons: certificateData.completedLessons,
        progress: certificateData.progress,
        instructors: certificateData.instructors,
        creatorName: certificateData.creatorName,
      },
    })

    res.status(200).json({
      status: 'success',
      message: 'Certificate data generated successfully',
      data: certificateData,
    })
  } catch (error) {
    next(error)
  }
}

// Helper function to check course completion and get data
async function getCourseCompletionData(userId, courseId) {
  // Get the course details
  const course = await Course.findById(courseId)
    .populate('creator', 'firstName lastName')
    .populate({
      path: 'modules',
      match: { isDeleted: false },
      select: '_id',
    })

  if (!course) {
    throw new AppError('Course not found', 404)
  }

  // Get user enrollment
  const user = await User.findById(userId).select('firstName lastName enrolledCourses')
  if (!user) {
    throw new AppError('User not found', 404)
  }

  const enrollment = user.enrolledCourses.find((ec) => ec.course && ec.course.toString() === courseId)

  if (!enrollment) {
    throw new AppError('Not enrolled in this course', 403)
  }

  // Check if enrollment is for full course
  if (enrollment.enrollmentType !== 'full') {
    throw new AppError('Only full course enrollments are eligible for course certificates', 403)
  }

  // Get progress for all modules in this course
  const allModuleIds = course.modules.map((m) => m._id)

  const progressRecords = await Progress.find({
    user: userId,
    course: courseId,
    module: { $in: allModuleIds },
  })

  // Check if all modules are completed
  const completedModules = progressRecords.filter((p) => p.progress === 100)
  const isCompleted = allModuleIds.length > 0 && completedModules.length === allModuleIds.length

  // Get completion date (date of last module completion)
  let completionDate = null
  if (isCompleted && progressRecords.length > 0) {
    // Find the most recent update among all modules
    completionDate = new Date(Math.max(...progressRecords.map((p) => p.updatedAt.getTime())))
  }

  return {
    isCompleted,
    certificateType: 'course',
    courseTitle: course.title,
    studentName: `${user.firstName} ${user.lastName}`,
    instructors: course.instructors.map((i) => i.name),
    creatorName: course.creator ? `${course.creator.firstName} ${course.creator.lastName}` : 'Unknown',
    completionDate,
    courseId: course._id,
    category: course.category,
    totalModules: allModuleIds.length,
    completedModules: completedModules.length,
    issueDate: new Date(),
  }
}

// Helper function to check module completion and get data
async function getModuleCompletionData(userId, courseId, moduleId) {
  // Get the module details
  const module = await Module.findOne({
    _id: moduleId,
    course: courseId,
    isDeleted: false,
  })

  if (!module) {
    throw new AppError('Module not found', 404)
  }

  // Get lesson count for this module
  const totalLessons = await Lesson.countDocuments({
    module: moduleId,
    isDeleted: false,
  })

  // Get the course details for additional info
  const course = await Course.findById(courseId).populate('creator', 'firstName lastName')

  if (!course) {
    throw new AppError('Course not found', 404)
  }

  // Get user enrollment
  const user = await User.findById(userId).select('firstName lastName enrolledCourses')
  if (!user) {
    throw new AppError('User not found', 404)
  }

  const enrollment = user.enrolledCourses.find((ec) => ec.course && ec.course.toString() === courseId)

  if (!enrollment) {
    throw new AppError('Not enrolled in this course', 403)
  }

  // Check module enrollment
  const hasModuleAccess = enrollment.enrollmentType === 'full' || enrollment.enrolledModules.some((em) => em.module && em.module.toString() === moduleId)

  if (!hasModuleAccess) {
    throw new AppError('Not enrolled in this module', 403)
  }

  // Get progress for this module
  const progress = await Progress.findOne({
    user: userId,
    course: courseId,
    module: moduleId,
  })

  if (!progress) {
    return {
      isCompleted: false,
      moduleTitle: module.title,
      courseTitle: course.title,
      studentName: `${user.firstName} ${user.lastName}`,
    }
  }

  // Module is completed if progress is 100%
  const isCompleted = progress.progress === 100

  return {
    isCompleted,
    certificateType: 'module',
    moduleTitle: module.title,
    courseTitle: course.title,
    studentName: `${user.firstName} ${user.lastName}`,
    instructors: course.instructors.map((i) => i.name),
    creatorName: course.creator ? `${course.creator.firstName} ${course.creator.lastName}` : 'Unknown',
    completionDate: progress.updatedAt,
    courseId: course._id,
    moduleId: module._id,
    category: course.category,
    totalLessons,
    completedLessons: progress.completedLessons.length,
    progress: progress.progress,
    issueDate: new Date(),
  }
}

// Mock certificate for a course (no completion validation)
exports.getMockCourseCertificate = async (req, res, next) => {
  try {
    const { courseId } = req.params
    const userId = req.user._id

    // Get the course details
    const course = await Course.findById(courseId)
      .populate('creator', 'firstName lastName')
      .populate({
        path: 'modules',
        match: { isDeleted: false },
        select: '_id',
      })

    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    // Get user data
    const user = await User.findById(userId).select('firstName lastName')
    if (!user) {
      return next(new AppError('User not found', 404))
    }

    // Check if a mock certificate already exists
    let certificate = await Certificate.findOne({
      user: userId,
      course: courseId,
      certificateType: 'course',
      'metadata.isMock': true,
      isRevoked: false,
    })

    let certificateId

    if (certificate) {
      // Use existing certificate
      certificateId = certificate.certificateId
    } else {
      // Generate certificate ID for new certificate
      certificateId = generateCertificateId('course')

      // Save mock certificate to database
      certificate = await Certificate.create({
        certificateId,
        certificateType: 'course',
        user: userId,
        course: courseId,
        courseTitle: course.title,
        studentName: `${user.firstName} ${user.lastName}`,
        completionDate: new Date(),
        issueDate: new Date(),
        metadata: {
          isMock: true,
          category: course.category,
          totalModules: course.modules.length,
          completedModules: course.modules.length,
          instructors: course.instructors.map((i) => i.name),
          creatorName: course.creator ? `${course.creator.firstName} ${course.creator.lastName}` : 'Unknown',
        },
      })
    }

    // Generate mock certificate data
    const certificateData = {
      isCompleted: true, // Always true for mock
      certificateType: 'course',
      courseTitle: course.title,
      studentName: `${user.firstName} ${user.lastName}`,
      instructors: course.instructors.map((i) => i.name),
      creatorName: course.creator ? `${course.creator.firstName} ${course.creator.lastName}` : 'Unknown',
      completionDate: certificate.completionDate,
      courseId: course._id,
      category: course.category,
      totalModules: course.modules.length,
      completedModules: course.modules.length, // All modules marked as completed
      issueDate: certificate.issueDate,
      certificateId,
    }

    res.status(200).json({
      status: 'success',
      message: 'Mock certificate data generated successfully',
      data: certificateData,
    })
  } catch (error) {
    next(error)
  }
}

// Mock certificate for a module (no completion validation)
exports.getMockModuleCertificate = async (req, res, next) => {
  try {
    const { courseId, moduleId } = req.params
    const userId = req.user._id

    // Get the module details
    const module = await Module.findOne({
      _id: moduleId,
      course: courseId,
      isDeleted: false,
    })

    if (!module) {
      return next(new AppError('Module not found', 404))
    }

    // Get lesson count for this module
    const totalLessons = await Lesson.countDocuments({
      module: moduleId,
      isDeleted: false,
    })

    // Get the course details for additional info
    const course = await Course.findById(courseId).populate('creator', 'firstName lastName')

    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    // Get user data
    const user = await User.findById(userId).select('firstName lastName')
    if (!user) {
      return next(new AppError('User not found', 404))
    }

    // Check if a mock certificate already exists
    let certificate = await Certificate.findOne({
      user: userId,
      course: courseId,
      module: moduleId,
      certificateType: 'module',
      'metadata.isMock': true,
      isRevoked: false,
    })

    let certificateId

    if (certificate) {
      // Use existing certificate
      certificateId = certificate.certificateId
    } else {
      // Generate certificate ID for new certificate
      certificateId = generateCertificateId('module')

      // Save mock certificate to database
      certificate = await Certificate.create({
        certificateId,
        certificateType: 'module',
        user: userId,
        course: courseId,
        module: moduleId,
        courseTitle: course.title,
        moduleTitle: module.title,
        studentName: `${user.firstName} ${user.lastName}`,
        completionDate: new Date(),
        issueDate: new Date(),
        metadata: {
          isMock: true,
          category: course.category,
          totalLessons,
          completedLessons: totalLessons,
          progress: 100,
          instructors: course.instructors.map((i) => i.name),
          creatorName: course.creator ? `${course.creator.firstName} ${course.creator.lastName}` : 'Unknown',
        },
      })
    }

    // Generate mock certificate data
    const certificateData = {
      isCompleted: true, // Always true for mock
      certificateType: 'module',
      moduleTitle: module.title,
      courseTitle: course.title,
      studentName: `${user.firstName} ${user.lastName}`,
      instructors: course.instructors.map((i) => i.name),
      creatorName: course.creator ? `${course.creator.firstName} ${course.creator.lastName}` : 'Unknown',
      completionDate: certificate.completionDate,
      courseId: course._id,
      moduleId: module._id,
      category: course.category,
      totalLessons: totalLessons,
      completedLessons: totalLessons, // All lessons marked as completed
      progress: 100, // 100% progress
      issueDate: certificate.issueDate,
      certificateId,
    }

    res.status(200).json({
      status: 'success',
      message: 'Mock certificate data generated successfully',
      data: certificateData,
    })
  } catch (error) {
    next(error)
  }
}
