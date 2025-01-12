const Joi = require('joi');
const mongoose = require('mongoose');
const { Course, Module, User, Progress, Lesson, Quiz } = require('../models');
const { AppError } = require('../utils/errors');
const { uploadToS3, deleteFromS3 } = require('../utils/s3');
const sanitizeHtml = require('sanitize-html');

const instructorSchema = Joi.object({
  name: Joi.string().required().trim().messages({
    'string.empty': 'Instructor name is required'
  }),
  description: Joi.string().required().trim().messages({
    'string.empty': 'Instructor description is required'
  }),
  designation: Joi.string().trim(),
  expertise: Joi.array().items(Joi.string().trim()),
  socialLinks: Joi.object({
    linkedin: Joi.string().uri().allow(''),
    twitter: Joi.string().uri().allow(''),
    website: Joi.string().uri().allow('')
  }),
  bio: Joi.string().trim(),
  achievements: Joi.array().items(Joi.string())
}).options({ stripUnknown: true });

const courseSchema = Joi.object({
  title: Joi.string().trim().min(5).max(100).required().messages({
    'string.min': 'Title must be at least 5 characters long',
    'string.max': 'Title cannot exceed 100 characters',
    'any.required': 'Title is required'
  }),
  description: Joi.string().trim().min(20).max(2000).required().messages({
    'string.min': 'Description must be at least 20 characters long',
    'string.max': 'Description cannot exceed 2000 characters',
    'any.required': 'Description is required'
  }),
  category: Joi.string().trim().required().messages({
    'any.required': 'Category is required'
  }),
  price: Joi.number().min(0).required().messages({
    'number.min': 'Price cannot be negative',
    'any.required': 'Price is required'
  }),
  featured: Joi.boolean(),
  instructors: Joi.array().min(1).items(instructorSchema).required().messages({
    'array.min': 'At least one instructor is required'
  })
}).options({ abortEarly: false });

const updateCourseSchema = courseSchema.fork(
  ['title', 'description', 'category', 'price', 'featured', 'instructors'],
  schema => schema.optional()
);

const querySchema = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
  category: Joi.string(),
  search: Joi.string(),
  minPrice: Joi.number().min(0),
  maxPrice: Joi.number().min(Joi.ref('minPrice')),
  sortBy: Joi.string().valid('createdAt', 'price', 'rating', 'totalStudents'),
  order: Joi.string().valid('asc', 'desc')
});

async function handleInstructorImages(instructors, instructorImages) {
  const processedInstructors = await Promise.all(instructors.map(async (instructor, index) => {
    const instructorImage = instructorImages?.[index];
    if (instructorImage) {
      const key = `instructor-images/${Date.now()}-${index}-${instructorImage.originalname}`;
      const imageUrl = await uploadToS3(instructorImage, key);
      return {
        ...instructor,
        image: imageUrl,
        imageKey: key
      };
    }
    return instructor;
  }));
  return processedInstructors;
}

async function cleanupInstructorImages(imageKeys) {
  await Promise.all(
    imageKeys.map(key => deleteFromS3(key).catch(console.error))
  );
}

exports.createCourse = async (req, res, next) => {
  let uploadedImageKeys = [];
  
  try {
    const courseData = JSON.parse(req.body.courseData);
    const { error, value } = courseSchema.validate(courseData);
    
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map(detail => ({
          field: detail.context.key,
          message: detail.message
        }))
      });
    }

    // Check for duplicate title
    const existingCourse = await Course.findOne({ title: value.title });
    if (existingCourse) {
      return next(new AppError('A course with this title already exists', 400));
    }

    // Handle course thumbnail
    let thumbnailUrl = null;
    let thumbnailKey = null;
    if (req.files?.thumbnail?.[0]) {
      thumbnailKey = `course-thumbnails/${Date.now()}-${req.files.thumbnail[0].originalname}`;
      thumbnailUrl = await uploadToS3(req.files.thumbnail[0], thumbnailKey);
      uploadedImageKeys.push(thumbnailKey);
    }

    // Handle instructor images
    const instructorsWithImages = await handleInstructorImages(
      value.instructors,
      req.files?.instructorImages
    );
    
    uploadedImageKeys = uploadedImageKeys.concat(
      instructorsWithImages
        .filter(inst => inst.imageKey)
        .map(inst => inst.imageKey)
    );

    // Sanitize description
    value.description = sanitizeHtml(value.description, {
      allowedTags: ['b', 'i', 'em', 'strong', 'p', 'br'],
      allowedAttributes: {}
    });

    const course = await Course.create({
      ...value,
      thumbnail: thumbnailUrl,
      thumbnailKey,
      instructors: instructorsWithImages,
      creator: req.user._id
    });

    const populatedCourse = await Course.findById(course._id)
      .populate('creator', 'firstName lastName email');

    res.status(201).json({
      status: 'success',
      data: populatedCourse
    });
  } catch (error) {
    // Cleanup uploaded images if course creation fails
    await cleanupInstructorImages(uploadedImageKeys);
    next(error);
  }
};

exports.updateCourse = async (req, res, next) => {
  let newUploadedImageKeys = [];
  
  try {
    const courseData = JSON.parse(req.body.courseData || '{}');
    const { error, value } = updateCourseSchema.validate(courseData);
    
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map(detail => ({
          field: detail.context.key,
          message: detail.message
        }))
      });
    }

    if (Object.keys(value).length === 0 && !req.files) {
      return next(new AppError('No update data provided', 400));
    }

    const course = await Course.findById(req.params.courseId);
    if (!course) {
      return next(new AppError('Course not found', 404));
    }

    // Handle thumbnail update
    if (req.files?.thumbnail?.[0]) {
      if (course.thumbnailKey) {
        await deleteFromS3(course.thumbnailKey).catch(console.error);
      }
      const thumbnailKey = `course-thumbnails/${Date.now()}-${req.files.thumbnail[0].originalname}`;
      const thumbnailUrl = await uploadToS3(req.files.thumbnail[0], thumbnailKey);
      value.thumbnail = thumbnailUrl;
      value.thumbnailKey = thumbnailKey;
      newUploadedImageKeys.push(thumbnailKey);
    }

    // Handle instructor updates
    if (value.instructors) {
      // Store old instructor image keys for potential cleanup
      const oldInstructorImageKeys = course.instructors
        .filter(inst => inst.imageKey)
        .map(inst => inst.imageKey);

      // Process new instructor images
      const instructorsWithImages = await handleInstructorImages(
        value.instructors,
        req.files?.instructorImages
      );

      // Add new image keys to tracking array
      newUploadedImageKeys = newUploadedImageKeys.concat(
        instructorsWithImages
          .filter(inst => inst.imageKey)
          .map(inst => inst.imageKey)
      );

      value.instructors = instructorsWithImages;

      // Clean up old instructor images
      await cleanupInstructorImages(oldInstructorImageKeys);
    }

    if (value.description) {
      value.description = sanitizeHtml(value.description, {
        allowedTags: ['b', 'i', 'em', 'strong', 'p', 'br'],
        allowedAttributes: {}
      });
    }

    if (value.title && value.title !== course.title) {
      const existingCourse = await Course.findOne({
        title: value.title,
        _id: { $ne: req.params.courseId }
      });
      if (existingCourse) {
        // Clean up any newly uploaded images
        await cleanupInstructorImages(newUploadedImageKeys);
        return next(new AppError('A course with this title already exists', 400));
      }
    }

    const updatedCourse = await Course.findByIdAndUpdate(
      req.params.courseId,
      { ...value },
      { new: true, runValidators: true }
    ).populate('creator', 'firstName lastName email');

    res.status(200).json({
      status: 'success',
      data: updatedCourse
    });
  } catch (error) {
    // Clean up newly uploaded images if update fails
    await cleanupInstructorImages(newUploadedImageKeys);
    next(error);
  }
};

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
      'enrolledCourses.course': course._id,
    }).session(session)

    if (activeEnrollments > 0) {
      // Soft delete if there are active enrollments
      course.isDeleted = true
      await course.save({ session })

      await Promise.all([
        Module.updateMany({ course: course._id }, { isDeleted: true }, { session }),
        Lesson.updateMany({ module: { $in: await Module.find({ course: course._id }).distinct('_id') } }, { isDeleted: true }, { session }),
      ])
    } else {
      // Hard delete if no active enrollments
      // Delete all images
      const imageKeys = [course.thumbnailKey, ...course.instructors.filter((inst) => inst.imageKey).map((inst) => inst.imageKey)].filter(Boolean)

      await cleanupInstructorImages(imageKeys)

      // Use deleteOne instead of remove
      await Course.deleteOne({ _id: course._id }).session(session)

      // Delete associated modules and lessons
      const modules = await Module.find({ course: course._id })
      await Promise.all([
        Module.deleteMany({ course: course._id }).session(session),
        Lesson.deleteMany({
          module: {
            $in: modules.map((module) => module._id),
          },
        }).session(session),
      ])
    }

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      message: 'Course deleted successfully',
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.getAllCourses = async (req, res, next) => {
  try {
    const { error, value } = querySchema.validate(req.query);
    if (error) {
      return next(new AppError(error.details[0].message, 400));
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
    } = value;

    const query = {};

    if (category) {
      query.category = category;
    }

    if (search) {
      query.$text = { $search: search };
    }

    if (!isNaN(minPrice) || !isNaN(maxPrice)) {
      query.price = {};
      if (!isNaN(minPrice)) query.price.$gte = minPrice;
      if (!isNaN(maxPrice)) query.price.$lte = maxPrice;
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
    ]);

    const totalPages = Math.ceil(totalCourses / limit);

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
    });
  } catch (error) {
    next(error);
  }
};

exports.getCourse = async (req, res, next) => {
  try {
    const course = await Course.findById(req.params.courseId)
      .populate('creator', 'firstName lastName email')
      .populate({
        path: 'modules',
        select: 'title description order price',
        options: { sort: { order: 1 } },
        populate: {
          path: 'lessons',
          select: 'title description order videoUrl duration requireQuizPass',
          options: { sort: { order: 1 } },
        },
      })

    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    const isCreator = course.creator._id.toString() === req.user?._id.toString()
    const isAdmin = req.user?.role === 'admin'
    const isEnrolled = req.user?.enrolledCourses?.some((enrollment) => enrollment.course.toString() === course._id.toString())

    if (!isCreator && !isAdmin && !course.featured && !isEnrolled) {
      const limitedCourse = {
        _id: course._id,
        title: course.title,
        description: course.description,
        category: course.category,
        price: course.price,
        thumbnail: course.thumbnail,
        creator: course.creator,
        instructors: course.instructors.map((instructor) => ({
          name: instructor.name,
          description: instructor.description,
          designation: instructor.designation,
          image: instructor.image,
          expertise: instructor.expertise,
          bio: instructor.bio,
          socialLinks: instructor.socialLinks,
        })),
        rating: course.rating,
        totalStudents: course.totalStudents,
        featured: course.featured,
      }

      return res.status(200).json({
        status: 'success',
        data: limitedCourse,
      })
    }

    res.status(200).json({
      status: 'success',
      data: course,
    })
  } catch (error) {
    next(error)
  }
}

exports.getFeaturedCourses = async (req, res, next) => {
  try {
    const courses = await Course.find({ featured: true }).select('-__v').populate('creator', 'firstName lastName').sort('-rating').limit(6).lean()

    res.status(200).json({
      status: 'success',
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
      Course.countDocuments({ category }),
      Course.find({ category })
        .select('-__v')
        .populate('creator', 'firstName lastName')
        .sort('-createdAt')
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
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
          hasPrevPage: page > 1,
        },
      },
    })
  } catch (error) {
    next(error)
  }
}


// const Joi = require('joi')
// const mongoose = require('mongoose')
// const { Course, Module, User, Progress, Lesson, Quiz } = require('../models')
// const { AppError } = require('../utils/errors')
// const { uploadToS3, deleteFromS3 } = require('../utils/s3')
// const sanitizeHtml = require('sanitize-html')

// // Validation Schemas
// const courseSchema = Joi.object({
//   title: Joi.string().trim().min(5).max(100).required().messages({
//     'string.min': 'Title must be at least 5 characters long',
//     'string.max': 'Title cannot exceed 100 characters',
//     'any.required': 'Title is required',
//   }),
//   description: Joi.string().trim().min(20).max(2000).required().messages({
//     'string.min': 'Description must be at least 20 characters long',
//     'string.max': 'Description cannot exceed 2000 characters',
//     'any.required': 'Description is required',
//   }),
//   category: Joi.string().trim().required().messages({
//     'any.required': 'Category is required',
//   }),
//   price: Joi.number().min(0).required().messages({
//     'number.min': 'Price cannot be negative',
//     'any.required': 'Price is required',
//   }),
//   featured: Joi.boolean(),
// }).options({ abortEarly: false })

// const updateCourseSchema = courseSchema.fork(['title', 'description', 'category', 'price', 'featured'], (schema) => schema.optional())

// const querySchema = Joi.object({
//   page: Joi.number().integer().min(1),
//   limit: Joi.number().integer().min(1).max(100),
//   category: Joi.string(),
//   search: Joi.string(),
//   minPrice: Joi.number().min(0),
//   maxPrice: Joi.number().min(Joi.ref('minPrice')),
//   sortBy: Joi.string().valid('createdAt', 'price', 'rating', 'totalStudents'),
//   order: Joi.string().valid('asc', 'desc'),
// })

// exports.createCourse = async (req, res, next) => {
//   let thumbnailKey = null

//   try {
//     const { error, value } = courseSchema.validate(req.body)
//     if (error) {
//       return res.status(400).json({
//         status: 'error',
//         errors: error.details.map((detail) => ({
//           field: detail.context.key,
//           message: detail.message,
//         })),
//       })
//     }

//     // Check for duplicate title
//     const existingCourse = await Course.findOne({ title: value.title })
//     if (existingCourse) {
//       return next(new AppError('A course with this title already exists', 400))
//     }

//     // Handle thumbnail upload
//     let thumbnailUrl = null
//     // if (req.file) {
//     //   thumbnailKey = `course-thumbnails/${Date.now()}-${req.file.originalname}`
//     //   thumbnailUrl = await uploadToS3(req.file, thumbnailKey)
//     // }

//     // Sanitize description
//     value.description = sanitizeHtml(value.description, {
//       allowedTags: ['b', 'i', 'em', 'strong', 'p', 'br'],
//       allowedAttributes: {},
//     })

//     // Create course with thumbnail
//     const course = await Course.create({
//       ...value,
//       thumbnail: thumbnailUrl,
//       thumbnailKey,
//       creator: req.user._id,
//     })

//     const populatedCourse = await Course.findById(course._id).populate('creator', 'firstName lastName email')

//     res.status(201).json({
//       status: 'success',
//       data: populatedCourse,
//     })
//   } catch (error) {
//     // Clean up uploaded image if course creation fails
//     if (thumbnailKey) {
//       await deleteFromS3(thumbnailKey).catch(console.error)
//     }
//     next(error)
//   }
// }

// exports.getAllCourses = async (req, res, next) => {
//   try {
//     const { error, value } = querySchema.validate(req.query)
//     if (error) {
//       return next(new AppError(error.details[0].message, 400))
//     }

//     const { page = 1, limit = 10, category, search, minPrice, maxPrice, sortBy = 'createdAt', order = 'desc' } = value

//     const query = {}

//     if (category) {
//       query.category = category
//     }

//     if (search) {
//       query.$text = { $search: search }
//     }

//     if (!isNaN(minPrice) || !isNaN(maxPrice)) {
//       query.price = {}
//       if (!isNaN(minPrice)) query.price.$gte = minPrice
//       if (!isNaN(maxPrice)) query.price.$lte = maxPrice
//     }

//     const [totalCourses, courses] = await Promise.all([
//       Course.countDocuments(query),
//       Course.find(query)
//         .select('-__v')
//         .populate('creator', 'firstName lastName email')
//         .sort({ [sortBy]: order === 'desc' ? -1 : 1 })
//         .skip((page - 1) * limit)
//         .limit(limit)
//         .lean(),
//     ])

//     const totalPages = Math.ceil(totalCourses / limit)

//     res.status(200).json({
//       status: 'success',
//       data: {
//         courses,
//         pagination: {
//           currentPage: page,
//           totalPages,
//           totalCourses,
//           hasNextPage: page < totalPages,
//           hasPrevPage: page > 1,
//         },
//       },
//     })
//   } catch (error) {
//     next(error)
//   }
// }

// exports.getCourse = async (req, res, next) => {
//   try {
//     const course = await Course.findById(req.params.courseId)
//       .populate('creator', 'firstName lastName email')
//       .populate({
//         path: 'modules',
//         select: 'title description order price',
//         options: { sort: { order: 1 } },
//         populate: {
//           path: 'lessons',
//           select: 'title description order videoUrl duration requireQuizPass',
//           options: { sort: { order: 1 } },
//         },
//       })

//     if (!course) {
//       return next(new AppError('Course not found', 404))
//     }

//     const isCreator = course.creator._id.toString() === req.user?._id.toString()
//     const isAdmin = req.user?.role === 'admin'
//     const isEnrolled = req.user?.enrolledCourses?.some((enrollment) => enrollment.course.toString() === course._id.toString())

//     if (!isCreator && !isAdmin && !course.featured && !isEnrolled) {
//       const limitedCourse = {
//         _id: course._id,
//         title: course.title,
//         description: course.description,
//         category: course.category,
//         price: course.price,
//         thumbnail: course.thumbnail,
//         creator: course.creator,
//         rating: course.rating,
//         totalStudents: course.totalStudents,
//         featured: course.featured,
//       }

//       return res.status(200).json({
//         status: 'success',
//         data: limitedCourse,
//       })
//     }

//     res.status(200).json({
//       status: 'success',
//       data: course,
//     })
//   } catch (error) {
//     next(error)
//   }
// }

// exports.updateCourse = async (req, res, next) => {
//   let newThumbnailKey = null

//   try {
//     const { error, value } = updateCourseSchema.validate(req.body)
//     if (error) {
//       return res.status(400).json({
//         status: 'error',
//         errors: error.details.map((detail) => ({
//           field: detail.context.key,
//           message: detail.message,
//         })),
//       })
//     }

//     if (Object.keys(value).length === 0 && !req.file) {
//       return next(new AppError('No update data provided', 400))
//     }

//     const course = await Course.findById(req.params.courseId)
//     if (!course) {
//       return next(new AppError('Course not found', 404))
//     }

//     // Handle thumbnail update
//     if (req.file) {
//       newThumbnailKey = `course-thumbnails/${Date.now()}-${req.file.originalname}`
//       const thumbnailUrl = await uploadToS3(req.file, newThumbnailKey)
//       value.thumbnail = thumbnailUrl
//       value.thumbnailKey = newThumbnailKey

//       // Delete old thumbnail
//       if (course.thumbnailKey) {
//         await deleteFromS3(course.thumbnailKey).catch(console.error)
//       }
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
//         // Clean up newly uploaded image if title update fails
//         if (newThumbnailKey) {
//           await deleteFromS3(newThumbnailKey).catch(console.error)
//         }
//         return next(new AppError('A course with this title already exists', 400))
//       }
//     }

//     const updatedCourse = await Course.findByIdAndUpdate(req.params.courseId, { ...value }, { new: true, runValidators: true }).populate(
//       'creator',
//       'firstName lastName email'
//     )

//     res.status(200).json({
//       status: 'success',
//       data: updatedCourse,
//     })
//   } catch (error) {
//     // Clean up newly uploaded image if update fails
//     if (newThumbnailKey) {
//       await deleteFromS3(newThumbnailKey).catch(console.error)
//     }
//     next(error)
//   }
// }

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
//       'enrolledCourses.course': course._id,
//     }).session(session)

//     if (activeEnrollments > 0) {
//       // Soft delete if there are active enrollments
//       course.isDeleted = true
//       await course.save({ session })

//       await Promise.all([
//         Module.updateMany({ course: course._id }, { isDeleted: true }, { session }),
//         Lesson.updateMany({ module: { $in: await Module.find({ course: course._id }).distinct('_id') } }, { isDeleted: true }, { session }),
//       ])
//     } else {
//       // Hard delete if no active enrollments
//       if (course.thumbnailKey) {
//         await deleteFromS3(course.thumbnailKey).catch(console.error)
//       }
//       await course.remove({ session })
//     }

//     await session.commitTransaction()

//     res.status(200).json({
//       status: 'success',
//       message: 'Course deleted successfully',
//     })
//   } catch (error) {
//     await session.abortTransaction()
//     next(error)
//   } finally {
//     session.endSession()
//   }
// }

// exports.getFeaturedCourses = async (req, res, next) => {
//   try {
//     const courses = await Course.find({ featured: true }).select('-__v').populate('creator', 'firstName lastName').sort('-rating').limit(6).lean()

//     res.status(200).json({
//       status: 'success',
//       data: courses,
//     })
//   } catch (error) {
//     next(error)
//   }
// }

// exports.getCoursesByCategory = async (req, res, next) => {
//   try {
//     const { category } = req.params
//     const page = parseInt(req.query.page) || 1
//     const limit = parseInt(req.query.limit) || 10

//     const [totalCourses, courses] = await Promise.all([
//       Course.countDocuments({ category }),
//       Course.find({ category })
//         .select('-__v')
//         .populate('creator', 'firstName lastName')
//         .sort('-createdAt')
//         .skip((page - 1) * limit)
//         .limit(limit)
//         .lean(),
//     ])

//     const totalPages = Math.ceil(totalCourses / limit)

//     res.status(200).json({
//       status: 'success',
//       data: {
//         courses,
//         pagination: {
//           currentPage: page,
//           totalPages,
//           totalCourses,
//           hasNextPage: page < totalPages,
//           hasPrevPage: page > 1,
//         },
//       },
//     })
//   } catch (error) {
//     next(error)
//   }
// }


