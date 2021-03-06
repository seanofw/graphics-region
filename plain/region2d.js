"use strict";

/**
 * First, a custom error type for regions, to make tracking and logging errors easier.
 */
function RegionError(message) {
	this.message = (this.name = "RegionError") + ": " + message;
	var stackPieces = String(new Error().stack).split('\n');
	stackPieces.shift();
	stackPieces.shift();
	this.stack = stackPieces.join('\n');
};
RegionError.prototype = Object.create ? Object.create(Error.prototype) : new Error();

/**
 * Region1D objects are semi-opaque data structures that represent a 1-dimensional
 * set on the number line, described using "spans" of included points.
 *
 * ------------------------------------------------------------------------------------------------
 *
 * Each span in the region has an inclusive start and an exclusive end.  Spans may
 * not overlap, and always must appear in sorted order.  So, for example, consider
 * this set:
 *
 *           #####  ####      ###########       ####     #
 *        |----+----|----+----|----+----|----+----|----+----|
 *       0     5   10   15   20   25   30   35   40   45   50
 *
 * This set (inclusively) contains the numbers 3-7, 10-13, 20-30, 38-41, and 47.
 * Its Region1D representation (using only integer values) would therefore
 * consist of these ranges:
 *
 *   [3,8); [10,14); [20,31); [38,42); [47,48)
 *
 * And thus the resulting data array stored by the Region1D object would be:
 *
 *   [3, 8, 10, 14, 20, 31, 38, 42, 47, 48]
 *
 * Note that when you construct a Region1D, you *must* provide the data array
 * in sorted order, or the Region1D's constraints will be violated.
 *
 * ------------------------------------------------------------------------------------------------
 *
 * Region1Ds provide many operations that can be used to manipulate their
 * data as formal sets, including:
 *
 *   result = a.union(b);           // Return a new set that is the logical union of the two sets.
 *   result = a.intersect(b);       // Return a new set that is the logical intersection of the two sets.
 *   result = a.subtract(b);        // Return the logical subtraction of the two sets, i.e., the
 *                                  //   equivalent of a.union(b.not()), but computed more efficiently.
 *   result = a.xor(b);             // Return the exclusive-or of the two sets, i.e., those ranges
 *                                  //   which exist in one set or the other but not both.
 *   result = a.not();              // Return the logical complement of the set (which may include infinity).
 *   result = a.isEmpty();          // Return true/false if the set is empty.
 *   result = a.isPointIn(x);       // Return true if the given coordinate is contained within the set.
 *   result = a.doesIntersect(b);   // Return true if the logical intersection of the two sets is nonempty.  This is
 *                                  //   more efficient than performing "!a.intersect(b).isEmpty()".
 *   result = a.equals(b);          // Return true if the sets are identical.
 *   result = a.getBounds(b);       // Return { min:, max: } of the Region1D.
 *   result = a.getAsRects(minY, maxY); // Return an array of { x:, y:, width:, height: } rectangles describing the Region1D.
 *   result = a.getRawSpans();      // Return a raw array of numbers, the same kind that was used to construct the Region1D.
 *
 * All Region1D operations are carefully written to be bounded in both time and
 * space, and all will run in no worse than O(n) or O(n+m) time.
 */
var Region1D = function () {

	var

	//---------------------------------------------------------------------------------------------
	// Global constants.

	// Precache positive/negative infinity locally.
	pInf = Number.POSITIVE_INFINITY,
	    nInf = Number.NEGATIVE_INFINITY,
	    regionError = RegionError,


	//---------------------------------------------------------------------------------------------
	// Helper functions.

	/**
  * Construct a wrapper around the given private data that makes it opaque except for 
  * those with access to the 'expectedKey'.
  */
	makeProtectedData = function makeProtectedData(protectedData, expectedKey) {
		return function (actualKey) {
			if (actualKey === expectedKey) return protectedData;else throw new regionError("Illegal access");
		};
	},


	/**
  * Determine if the given object is an array. This is provided in newer JavaScript environs,
  * but is notably lacking in older ones.  We avoid a dependency on a huge package like CoreJS
  * by just defining the shim here.
  */
	isArray = function isArray(o) {
		return Array.isArray ? Array.isArray(o) : o instanceof Array;
	},


	//---------------------------------------------------------------------------------------------
	// 1-D raw-data-manipulation functions.

	/**
  * Make a function that generates successive lowest values from each of the two given arrays.
  */
	makeCoordinateGenerator = function makeCoordinateGenerator(array1, array2) {
		var i1 = 0,
		    i2 = 0;

		// Get the next coordinate with the lowest value from either array, keeping
		// track of whether it is a begin (+1) or end (-1) coordinate of its span.  O(1).
		return function () {
			if (i1 >= array1.length && i2 >= array2.length) return null;else if (i1 >= array1.length) return { x: array2[i2], kind: i2++ & 1 ? -1 : +1, src: 2 };else if (i2 >= array2.length || array1[i1] < array2[i2]) return { x: array1[i1], kind: i1++ & 1 ? -1 : +1, src: 1 };else return { x: array2[i2], kind: i2++ & 1 ? -1 : +1, src: 2 };
		};
	},


	/**
  * Calculate the combination of the given (sorted!) arrays of 1-D region data.
  * Returns a new array that contains the 1-D combination.
  */
	combineData = function combineData(array1, array2, op) {

		// Special case: Nothin' from nothin' gives nothin'.
		if (!array1.length && !array2.length) return [];

		// Get the next coordinate with the lowest value from either array, keeping
		// track of whether it is a begin (+1) or end (-1) coordinate of its span.  O(1).
		var getNext = makeCoordinateGenerator(array1, array2);

		var depth1 = 0,
		    depth2 = 0;
		var state = 0,
		    lastState = 0;

		// Do whatever needs to happen at the very first coordinate.
		var coord = getNext();

		// Process all of the coordinates until both arrays are empty, collecting
		// new spans in the 'result' array.  O(n+m).
		var result = [];
		do {
			// Do whatever happens at this coordinate.
			if (coord.src === 1) depth1 += coord.kind;else depth2 += coord.kind;

			// Process any subsequent coordinates at the same 'x' offset,
			// also collecting the one after it.
			var nextCoord = void 0;
			while ((nextCoord = getNext()) && nextCoord.x === coord.x) {
				if (nextCoord.src === 1) depth1 += nextCoord.kind;else depth2 += nextCoord.kind;
			}

			// Change the state to match whatever happened here.
			lastState = state;
			state = op(depth1, depth2);

			// If we entered/exited a new span, emit a start/end X value.
			if (state !== lastState) {
				result.push(coord.x);
			}

			coord = nextCoord;
		} while (coord);

		return result;
	},


	/**
  * Calculate the union of the given arrays of 1-D region data.
  * Returns a new array that contains the 1-D union.
  */
	unionData = function unionData(array1, array2) {
		return combineData(array1, array2, function (depth1, depth2) {
			return depth1 | depth2;
		});
	},


	/**
  * Calculate the intersection of the given arrays of 1-D region data.
  * Returns a new array that contains the 1-D intersection.
  */
	intersectData = function intersectData(array1, array2) {
		return combineData(array1, array2, function (depth1, depth2) {
			return depth1 & depth2;
		});
	},


	/**
  * Calculate the exclusive-or of the given arrays of 1-D region data.
  * Returns a new array that contains the 1-D exclusive-or.
  */
	xorData = function xorData(array1, array2) {
		return combineData(array1, array2, function (depth1, depth2) {
			return depth1 ^ depth2;
		});
	},


	/**
  * Calculate the difference of the given arrays of 1-D region data.
  * Returns a new array that contains the 1-D difference.
  */
	subtractData = function subtractData(array1, array2) {
		return combineData(array1, array2, function (depth1, depth2) {
			return depth1 & ~depth2;
		});
	},


	/**
  * Calculate whether the given arrays of 1-D region data intersect, and
  * if so, how.  This requires constant memory, but it may take O(n+m) time.
  * 
  * If 'earlyOut' is true, this will return only '' or 'intersects', and
  * it will return that answer as soon as it possibly can, skipping testing
  * successive data if possible.
  * 
  * Returns one of:
  *    '': no intersection
  *    'intersect': there is at least some kind of intersection
  *    'a-contain-b': array1 is a proper superset of array2
  *    'b-contain-a': array2 is a proper superset of array1
  *    'equal': array1 and array2 represent the same exact region
  */
	relateData = function relateData(array1, array2, earlyOut) {

		// If either is empty, there's no intersection.
		if (!array1.length || !array2.length) return '';

		// If all of the spans of one are before all of the spans of another, there's no intersection.
		if (array1[array1.length - 1] < array2[0] || array2[array2.length - 1] < array1[0]) return '';

		// Test all the spans against each other.
		var depth1 = 0,
		    depth2 = 0;
		var getNext = makeCoordinateGenerator(array1, array2);

		// Do whatever needs to happen at the very first coordinate.
		var coord = getNext();

		// Bit flags:  We start out assuming A and B both contain each other, but there
		// is not yet an intersection.  It's weird, but go with it.
		var result = 3;

		do {
			// Do whatever happens at this coordinate.
			if (coord.src === 1) depth1 += coord.kind;else depth2 += coord.kind;

			// Process any subsequent coordinates at the same 'x' offset,
			// also collecting the one after it.
			var nextCoord = void 0;
			while ((nextCoord = getNext()) && nextCoord.x === coord.x) {
				if (nextCoord.src === 1) depth1 += nextCoord.kind;else depth2 += nextCoord.kind;
			}

			// Change the state to match whatever happened here.
			if (depth1 & depth2) {
				// Got an intersection.
				result |= 4;
				if (earlyOut) return 'intersect';
			} else if (depth2 & ~depth1) {
				// A does not contain B.
				result &= ~1;
			} else if (depth1 & ~depth2) {
				// B does not contain A.
				result &= ~2;
			}

			coord = nextCoord;
		} while (coord);

		// Choose an answer based on the resulting flag bits.
		switch (result) {
			case 4:
				return 'intersect'; // 1 0 0
			case 5:
				return 'a-contain-b'; // 1 0 1
			case 6:
				return 'b-contain-a'; // 1 1 0
			case 7:
				return 'equal'; // 1 1 1
			default:
				return ''; // 0 * *
		}
	},


	/**
  * Determine whether the given point lies within the spans of the Region1D data.
  */
	isPointInData = function isPointInData(array, x) {
		// It can't be in the empty set.
		if (!array.length) return false;

		// If it's outside the bounds, it's not anywhere within any of the spans.
		if (x < array[0] || x > array[array.length - 1]) return false;

		if (array.length <= 8) {
			// Spin over all the spans in a simple linear search.
			for (var i = 0, l = array.length; i < l; i += 2) {
				if (x >= array[i] && x < array[i + 1]) return true;
			}
			return false;
		} else {
			// Binary search to find the array index that x is either after or at.
			var start = 0,
			    end = array.length;
			var index = 0;
			while (start < end) {
				var midpt = (start + end) / 2 & ~0;
				var value = array[midpt];
				if (x === value) {
					index = midpt;
					break;
				} else if (x < value) {
					end = midpt;
				} else {
					index = midpt;
					start = midpt + 1;
				}
			}

			// 'index' now is the closest value at or before 'x', so we just need to see if
			// it's an odd or even array index to know if 'x' is inside the span or outside it.
			return !(index & 1);
		}
	},


	/**
  * Calculate a complement of the 1-D (sorted!) region data.
  * This is easy:
  *    If it starts with -Inf, remove that; otherwise, prepend -Inf.
  *    If it ends with +Inf, remove that; otherwise, append +Inf.
  * Returns a new array that contains the 1D complement.
  */
	notData = function notData(array) {
		var newArray = [];

		var src = 0;

		if (!array.length) {
			newArray.push(nInf);
			newArray.push(pInf);
			return newArray;
		} else {
			if (array[src] != nInf) newArray.push(nInf);else src++;
		}

		while (src < array.length - 1) {
			newArray.push(array[src++]);
		}

		if (array[src] != pInf) {
			newArray.push(array[src++]);
			newArray.push(pInf);
		}

		return newArray;
	},


	/**
  * Calculate a new region whose coordinates have all been translated/scaled by the given amounts.
  */
	transformData = function transformData(array, ratio, delta) {
		delta = Number(delta);
		if (!(nInf < delta && delta < pInf)) // Catches other NaNs as well as infinities.
			throw new regionError("Invalid translation delta");
		ratio = Number(ratio);
		if (!(nInf < ratio && ratio < pInf) || ratio === 0) // Catches other NaNs as well as infinities.
			throw new regionError("Invalid scale ratio");

		var newArray = [];
		for (var i = 0, l = array.length; i < l; i++) {
			newArray[i] = array[i] * ratio + delta;
		}

		return newArray;
	},


	/**
  * Determine if two arrays of (sorted!) 1-D region data are equivalent.
  * Returns true if they are the same, false if they are different.
  */
	arrayEquals = function arrayEquals(array1, array2) {
		if (array1.length !== array2.length) return false;
		for (var i = 0, l = array1.length; i < l; i++) {
			if (array1[i] !== array2[i]) return false;
		}
		return true;
	},


	/**
  * Transform a set of 1-D region data into an array of rectangles with
  * the given same y and height values.
  *
  * Returns a new array that contains rectangles of the form { x:, y:, width:, height:, left:, top:, right:, bottom: }.
  */
	makeRects = function makeRects(array, minY, maxY, result) {
		var height = maxY - minY;

		for (var i = 0, l = array.length; i < l; i += 2) {
			var minX = array[i];
			var maxX = array[i + 1];
			result.push({
				x: minX, y: minY, width: maxX - minX, height: height,
				left: minX, top: minY, right: maxX, bottom: maxY
			});
		}

		return result;
	},


	/**
  * Clone a set of 1-D region data into a raw array.
  * Returns a new array that contains pairs of points.
  */
	makeRawSpans = function makeRawSpans(array) {
		var result = [];
		for (var i = 0, l = array.length; i < l; i += 2) {
			result.push(array[i]);
			result.push(array[i + 1]);
		}
		return result;
	},


	/**
  * Calculate a hash that (loosely) describes the given Region1D of data, so that we
  * can readily tell whether it is different from another.
  */
	makeHashCode = function makeHashCode(array) {
		var hash = 0;
		for (var i = 0, l = array.length; i < l; i++) {
			hash *= 23;
			hash += array[i] | 0;
			hash &= ~0;
		}
		return hash;
	},


	/**
  * Check to ensure that the given object is actually a Region1D, and abort if it is not.
  */
	verifyRegion1DType = function verifyRegion1DType(obj) {
		if (!(obj instanceof Region1D)) {
			throw new regionError("Object must be a Region1D instance.");
		}
	},


	/**
  * Check the given data to make sure that it consists of an array of ordered pairs
  * of span start/end points.
  */
	validateData = function validateData(array) {

		var typeErrorMsg = "Expected an ordered array of numeric start/end pairs.";
		var dataErrorMsg = "Array start/end pairs are not in strictly ascending order.";

		// Make sure it's an array of even length.
		if (!isArray(array) || array.length & 1) {
			throw new regionError(typeErrorMsg);
		}

		// Empty array is always valid.
		if (array.length == 0) return;

		// Get the first entry, and make sure it's a number.
		var prev = array[0];
		if (typeof prev !== 'number') {
			throw new regionError(typeErrorMsg);
		}

		// Check each successive entry to make sure that it's (A) a number and (B) strictly
		// greater than the entry before it.
		for (var i = 1, l = array.length; i < l; i++) {
			var cur = array[i];
			if (typeof cur !== 'number') {
				throw new regionError(typeErrorMsg);
			}
			if (cur <= prev) {
				throw new regionError(dataErrorMsg);
			}
			prev = cur;
		}
	},


	//---------------------------------------------------------------------------------------------
	// Public interface.

	/**
  * A special private object used to flag internal constructions in such a way that
  * external callers' data must be validated, but internal data can skip those checks.
  */
	privateKey = {},


	/**
  * Access the internal data, if this is an allowed thing to do.
  */
	getData = function getData(region) {
		return region._opaque(privateKey);
	};

	/**
  * Construct a 1-D region from the given array of start/end X coordinates.  This is a
  * proper object, with prototype methods for performing operations like
  * union/intersect/subtract/xor.
  *
  * Usage:  new Region1D(array)
  *
  * @param array {Array} - The array of span endpoints, in pairs of start (inclusive)
  *        and end (exclusive) X-coordinates.
  */
	function Region1D(array, key, hash) {

		// Internal-only second parameter: A 'key' flag, indicating this data came from an
		// internal operation and does not require validation for correctness.
		if (key === privateKey) {

			// Internal-only third parameter: A hash for comparisons.
			if (typeof hash !== 'number') hash = makeHashCode(array);
		} else if (typeof key !== 'undefined' || typeof hash !== 'undefined') {
			// You're not allowed to specify a key unless it's the right one.
			throw new regionError("Illegal access");
		} else {
			// Verify that the user passed us data that makes sense.
			validateData(array);
			hash = makeHashCode(array);
		}

		this._opaque = makeProtectedData({
			array: array,
			min: array.length ? array[0] : pInf,
			max: array.length ? array[array.length - 1] : nInf,
			hash: hash
		}, privateKey);
	};

	/**
  * The row's prototype contains helpers that simply invoke the private operations
  * to do all the hard work.
  */
	Region1D.prototype = {
		union: function union(other) {
			verifyRegion1DType(other);
			var data = getData(this),
			    otherData = getData(other);
			return new Region1D(unionData(data.array, otherData.array), privateKey);
		},
		intersect: function intersect(other) {
			verifyRegion1DType(other);
			var data = getData(this),
			    otherData = getData(other);
			return new Region1D(intersectData(data.array, otherData.array), privateKey);
		},
		subtract: function subtract(other) {
			verifyRegion1DType(other);
			var data = getData(this),
			    otherData = getData(other);
			return new Region1D(subtractData(data.array, otherData.array), privateKey);
		},
		xor: function xor(other) {
			verifyRegion1DType(other);
			var data = getData(this),
			    otherData = getData(other);
			return new Region1D(xorData(data.array, otherData.array), privateKey);
		},
		not: function not() {
			var data = getData(this);
			return new Region1D(notData(data.array), privateKey);
		},
		transform: function transform(scale, offset) {
			var data = getData(this);
			return new Region1D(transformData(data.array, scale, offset)); // No privateKey forces a data check, since we could have lost precision.
		},
		translate: function translate(offset) {
			var data = getData(this);
			return new Region1D(transformData(data.array, 1.0, offset)); // No privateKey forces a data check, since we could have lost precision.
		},
		scale: function scale(_scale) {
			var data = getData(this);
			return new Region1D(transformData(data.array, _scale, 0)); // No privateKey forces a data check, since we could have lost precision.
		},
		isEmpty: function isEmpty() {
			return !getData(this).array.length;
		},
		getCount: function getCount() {
			return getData(this).array.length >> 1;
		},
		doesIntersect: function doesIntersect(other) {
			verifyRegion1DType(other);
			return !!relateData(getData(this).array, getData(other).array, true);
		},
		relate: function relate(other) {
			verifyRegion1DType(other);
			return relateData(getData(this).array, getData(other).array, false);
		},
		isPointIn: function isPointIn(x) {
			return isPointInData(getData(this).array, Number(x));
		},
		equals: function equals(other) {
			verifyRegion1DType(other);
			var data = getData(this),
			    otherData = getData(other);
			if (data === otherData) return true;
			if (data.hash !== otherData.hash) return false;
			return arrayEquals(data.array, otherData.array);
		},
		getRawSpans: function getRawSpans() {
			var data = getData(this);
			return makeRawSpans(data.array);
		},
		getAsRects: function getAsRects(minY, maxY, destArray) {
			var data = getData(this);
			return makeRects(data.array, minY, maxY, destArray || []);
		},
		getBounds: function getBounds() {
			var data = getData(this);
			return { min: data.min, max: data.max };
		},
		getHashCode: function getHashCode() {
			return getData(this).hash;
		}
	};

	// Construct a convenient shareable 'empty' instance.
	Region1D.empty = new Region1D([], privateKey, 0);

	return Region1D;
}();

/**
 * Region2D objects are semi-opaque data structures that represent a 2-dimensional
 * set in the plane, described using axis-aligned rectangles of included points.
 * 
 * ------------------------------------------------------------------------------------------------
 * 
 * Region2D objects are capable of performing most major set-theoretic operations, including:
 * 
 *   result = a.union(b);           // Return a new set that is the logical union of the two sets.
 *   result = a.intersect(b);       // Return a new set that is the logical intersection of the two sets.
 *   result = a.subtract(b);        // Return the logical subtraction of the two sets, i.e., the
 *                                  //   equivalent of a.union(b.not()), but computed more efficiently.
 *   result = a.xor(b);             // Return the exclusive-or of the two sets, i.e., those ranges
 *                                  //   which exist in one set or the other but not both.
 *   result = a.not();              // Return the logical complement of the set (which may include infinity).
 *   result = a.isEmpty();          // Return true/false if the set is empty.
 *   result = a.isFinite();         // Return true/false if the set is finite (doesn't stretch to infinity).
 *   result = a.isInfinite();       // Return true/false if the set stretches to infinity in any direction.
 *   result = a.isRectangular();    // Return true/false if the set can be described by a single rectangle.
 *   result = a.isPointIn(x, y);    // Return true if the given point is contained within the set.
 *   result = a.doesIntersect(b);   // Return true if the logical intersection of the two sets is nonempty.  This is
 *                                  //   more efficient than performing "!a.intersect(b).isEmpty()".
 *   result = a.equals(b);          // Return true if the sets are identical.
 *   result = a.getCount();         // Return the number of nonoverlapping rectangles that would describe this Region2D.
 *   result = a.getRects();			// Return an array of nonoverlapping rectangles describing the Region2D.
 *   result = a.getBounds(b);       // Return a boundary rectangle containing all of the points of the Region2D.
 *
 * All Region2D operations are carefully written to be bounded in both time and
 * space, and all will run in no worse than O(n) or O(n+m) time.
 *
 * ------------------------------------------------------------------------------------------------
 * 
 * Under the hood, this is partially implemented using Region1D.  Each Region2D consists of an
 * array of Region1D "rows" or "bands," which represent sets of rectangles with identical
 * minY/maxY coordinates.  Each of the rows must be nonempty and must be unique (i.e., a successive
 * row's spans must not equal a previous row spans, if the maxY of the previous row equals the minY
 * of the successive row).
 * 
 * Representing regions like this is how X Windows does it, and while this design may not always
 * result in the most optimized set of rectangles, the operations to work with these kinds of
 * regions are provably efficient:  This design trades space for time.
 * 
 * As a rather nice side-effect of the design, calls to getRects() will always result in a set
 * of rectangles that go from top-to-bottom, left-to-right on the screen, which can be beneficial
 * in some rendering scenarios.
 * 
 * This implementation also has performance optimizations to avoid combining regions when the
 * operations are meaningless or would result in the empty set, and there are various kinds of
 * boundary checks to early-out operations wherever possible.
 */
var Region2D = function () {

	var infinite = void 0,
	    empty = void 0;

	var

	//---------------------------------------------------------------------------------------------
	// Global constants.

	// Precache positive/negative infinity locally.
	pInf = Number.POSITIVE_INFINITY,
	    nInf = Number.NEGATIVE_INFINITY,
	    regionError = RegionError,


	//---------------------------------------------------------------------------------------------
	// Helper functions.

	/**
  * Construct a wrapper around the given private data that makes it opaque except for 
  * those with access to the 'expectedKey'.
  */
	makeProtectedData = function makeProtectedData(protectedData, expectedKey) {
		return function (actualKey) {
			if (actualKey === expectedKey) return protectedData;else throw new regionError("Illegal access");
		};
	},


	/**
  * Determine if the given object is an array. This is provided in newer JavaScript environs,
  * but is notably lacking in older ones.  We avoid a dependency on a huge package like CoreJS
  * by just defining the shim here.
  */
	isArray = function isArray(o) {
		return Array.isArray ? Array.isArray(o) : o instanceof Array;
	},


	//---------------------------------------------------------------------------------------------
	// Region core internals.

	/**
  * Make a 'generator' function that, upon each invocation, will return the next
  * pair of rows that need to be combined, as the form { row1:, row2:, minY:, maxY: },
  * where row1 and row2 are the original Region1D objects, and minY and maxY should
  * be the Y coordinates of the resulting combined row.  This is actually a lot simpler
  * than it looks, but many separate cases need to be handled.
  * 
  * On each separate invocation, the generator will return a new pair object until it
  * runs out of source rows, and then it will return null.
  */
	makeRowPairGenerator = function makeRowPairGenerator(rows1, rows2) {
		var rowIndex1 = 0;
		var rowIndex2 = 0;
		var lastY = nInf;
		var empty = Region1D.empty;

		return function () {

			//-------------------------------------------------------------------------------------
			// Step 1.  First, see if we've run out of data in either set.

			if (rowIndex1 >= rows1.length) {
				// No more left in rows1, so just take whatever's left of rows2.
				if (rowIndex2 >= rows2.length) return null;else {
					var _result = {
						row1: empty, row2: rows2[rowIndex2].region,
						minY: Math.max(rows2[rowIndex2].minY, lastY), maxY: lastY = rows2[rowIndex2].maxY
					};
					rowIndex2++;
					return _result;
				}
			} else if (rowIndex2 >= rows2.length) {
				// No more left in rows2, so just take whatever's left of rows1.
				var _result2 = {
					row1: rows1[rowIndex1].region, row2: empty,
					minY: Math.max(rows1[rowIndex1].minY, lastY), maxY: lastY = rows1[rowIndex1].maxY
				};
				rowIndex1++;
				return _result2;
			} else {}
			// We have remaining rows in both rows1 and rows2, so now we need
			// to do the general case.


			//-------------------------------------------------------------------------------------
			// Step 2. Extract out the next row pair.  This is a somewhat-straightforward
			//   decision-tree approach, and is very fast, but since there are many possible
			//   cases, there are a lot of conditionals below to test for all of them.

			var row1 = rows1[rowIndex1];
			var row2 = rows2[rowIndex2];
			var nextY1 = Math.max(row1.minY, lastY);
			var nextY2 = Math.max(row2.minY, lastY);

			var da = void 0,
			    db = void 0,
			    minY = void 0,
			    maxY = void 0;

			if (nextY1 === nextY2) {
				// The A-side and B-side rows having a matching top edge.
				minY = nextY1;

				// These match the first half of the conditionals described below.
				da = row1.region, db = row2.region;
				if (row2.maxY < row1.maxY) {
					lastY = maxY = row2.maxY;
					rowIndex2++;
				} else if (row2.maxY === row1.maxY) {
					lastY = maxY = row1.maxY;
					rowIndex1++, rowIndex2++;
				} else {
					lastY = maxY = row1.maxY;
					rowIndex1++;
				}
			} else if (nextY1 < nextY2) {
				// The A-side row is strictly above the B-side row.
				minY = nextY1;

				// These match the second half of the conditionals described below.
				da = row1.region, db = empty;
				if (nextY2 >= row1.maxY) {
					lastY = maxY = row1.maxY;
					rowIndex1++;
				} else {
					lastY = maxY = nextY2;
				}
			} else {
				// The B-side row is strictly above the A-side row.
				minY = nextY2;

				// These match the second half of the conditionals described below, inverted.
				da = empty, db = row2.region;
				if (nextY1 >= row2.maxY) {
					lastY = maxY = row2.maxY;
					rowIndex2++;
				} else {
					lastY = maxY = nextY1;
				}
			}

			//-------------------------------------------------------------------------------------
			// Step 3. Emit the result for this row pair.

			var result = {
				row1: da, row2: db,
				minY: minY, maxY: maxY
			};
			return result;

			/*
   	//-------------------------------------------------------------------------------------
   	// Step 2, in detail.  Both sides follow the same basic algorithm, as
   	// explained below:
   	//
   	// Find the maxY, and iterate whichever side is the next one that requires
   	// iteration (possibly both).
   		if (ay === by) {
   		// Top edges are equal, so we're consuming part or all of both rows.
   		//
   		// Case 1.  +-------+   +-------+   <--- top equal
   		//          |   a   |   |   b   |
   			// Three possibilities:  rb.maxY is above, equal to, or below ra.maxY.
   		if (rb.maxY < ra.maxY) {
   			// Case 1a.  +-------+   +-------+   <--- top equal
   			//           |   a   |   |   b   |
   			//           |       |   +-------+   <--- bottom above
   			//           +-------+
   			// Consume all of rb, but only the top part of ra.
   			lastY = maxY = rb.maxY;
   			da = ra.region;
   			db = rb.region;
   			ib++;
   		}
   		else if (rb.maxY === ra.maxY) {
   			// Case 1b.  +-------+   +-------+   <--- top equal
   			//           |   a   |   |   b   |
   			//           +-------+   +-------+   <--- bottom equal
   			// Consume both ra and rb.
   			lastY = maxY = ra.maxY;
   			da = ra.region;
   			db = rb.region;
   			ia++;
   			ib++;
   		}
   		else {
   			// Case 1c.  +-------+   +-------+   <--- top equal
   			//           |   a   |   |   b   |
   			//           +-------+   |       |
   			//                       +-------+   <--- bottom below
   			// Consume all of ra, but only the top part of rb.
   			lastY = maxY = ra.maxY;
   			da = ra.region;
   			db = rb.region;
   			ia++;
   		}
   	}
   	else if (by >= ra.maxY) {
   		// Degenerate case:  by is past ra.maxY, so there
   		// is no overlap at all.
   		//
   		// Case 2.  +-------+   
   		//          |   a   |
   		//          +-------+
   		//                      +-------+   <--- top entirely below a
   		//                      |   b   |
   		//                      +-------+
   		// Consume all of ra, and none of rb.
   		lastY = maxY = ra.maxY;
   		da = ra.region;
   		db = empty;
   		ia++;
   	}
   	else {
   		// Top edge of rb is below the top edge of ra, but there's definitely
   		// overlap.  So we now need to decide how much overlap.
   		//
   		// Case 3.  +-------+   
   		//          |   a   |   +-------+   <--- top below
   		//          |       |   |   b   |
   		//
   		// Consume the next part of ra through by, but none of rb.
   		lastY = maxY = by;
   		da = ra.region;
   		db = empty;
   	}
   */
		};
	},


	/**
  * Combine two regions together, returning a new region that is the result of having
  * combined them, using the provided rowTransform to mutate their individual rows.
  *
  * This spins over the rows of the regions in parallel, "peeling off" each successive
  * unique pair of rows with identical Y coordinates, and then invokes the transform
  * to perform the actual combination.  The transformed row is then added to the pile
  * of output rows, with a few interesting caveats to maintain the region invariants:
  *
  *   - We don't add a row that is identical to the previous row; we expand the previous row.
  *   - We don't add empty rows at all.
  *   - We do track the boundary min/max X coordinates as we go.
  *   - We compute the overall region hash as we go.
  *   - We only compute the boundary min/max Y coordinates after all rows are added.
  *
  * Neither input region may be empty.
  *
  * The result is always a valid region if the two input regions are valid regions.
  */
	combineData = function combineData(array1, array2, rowTransform) {

		// Make the generator that spits out pairs of rows to combine.
		var pairGenerator = makeRowPairGenerator(array1, array2);

		// Spin over all the pairs of input rows, and combine them together to produce
		// the output region.
		var lastResult = null;
		var result = [];
		var minX = pInf,
		    maxX = nInf;
		var hash = 0;
		var count = 0;
		for (var pair; pair = pairGenerator();) {

			// Perform the 1-dimensional version of the transform.
			var resultRow = rowTransform(pair.row1, pair.row2);

			// If the result is empty, we don't add it.
			if (resultRow.isEmpty()) continue;

			// If the result is the same as the previous row's result, and they're immediately
			// adjacent, then just expand the previous row: Don't add a new one.
			if (lastResult && resultRow.equals(lastResult.region) && lastResult.maxY == pair.minY) {
				lastResult.maxY = pair.maxY;
				continue;
			}

			// New result row, and it's valid content, so add it to the result.
			result.push(lastResult = {
				region: resultRow,
				minY: pair.minY,
				maxY: pair.maxY
			});

			// Update the rectangle count.
			count += resultRow.getCount();

			// Update the minima and maxima for this 2-D region based on the new row.
			var rowBounds = resultRow.getBounds();
			if (rowBounds.min < minX) minX = rowBounds.min;
			if (rowBounds.max > maxX) maxX = rowBounds.max;

			// Update the hash (checksum) for the 2-D region based on the 1-D row hash.
			hash *= 23;
			hash += resultRow.getHashCode() | 0;
			hash &= ~0;
		}

		// Finally, generate the 2-D region data itself.
		var newRegionData = {
			array: result,
			count: count,
			minX: minX,
			minY: result.length ? result[0].minY : pInf,
			maxX: maxX,
			maxY: result.length ? result[result.length - 1].maxY : nInf,
			hash: hash
		};
		return newRegionData;
	},


	/**
  * Calculate the union of the given arrays of 2-D region data.
  * Returns a new array that contains the 2-D union.
  */
	unionData = function unionData(array1, array2) {
		return combineData(array1, array2, function (r1, r2) {
			return r1.union(r2);
		});
	},


	/**
  * Calculate the intersection of the given arrays of 2-D region data.
  * Returns a new array that contains the 2-D intersection.
  */
	intersectData = function intersectData(array1, array2) {
		return combineData(array1, array2, function (r1, r2) {
			return r1.intersect(r2);
		});
	},


	/**
  * Calculate the exclusive-or of the given arrays of 2-D region data.
  * Returns a new array that contains the 2-D exclusive-or.
  */
	xorData = function xorData(array1, array2) {
		return combineData(array1, array2, function (r1, r2) {
			return r1.xor(r2);
		});
	},


	/**
  * Calculate the difference of the given arrays of 2-D region data.
  * Returns a new array that contains the 2-D difference.
  */
	subtractData = function subtractData(array1, array2) {
		return combineData(array1, array2, function (r1, r2) {
			return r1.subtract(r2);
		});
	},


	//---------------------------------------------------------------------------------------------
	// Support for generation of paths/windings.

	/**
  * Extract the edges of this region.  The edges are fairly-easily extracted from the row data:
  * All vertical lines in each row are valid edges, and horizontal lines are valid wherever
  * the XOR with the adjacent row is nonempty.
  */
	generateEdges = function generateEdges(array) {
		var edges = [];

		if (array.length === 1) {
			// Degenerate case: Only one row.
			var spans = array[0].region.getRawSpans();
			var y1 = array[0].minY;
			var y2 = array[0].maxY;
			for (var i = 0; i < spans.length; i += 2) {
				edges.push({ x1: spans[i], y1: y1, x2: spans[i + 1], y2: y1, kind: "top",
					key1: null, key2: null, next: null, prev: null, used: false });
				edges.push({ x1: spans[i + 1], y1: y1, x2: spans[i + 1], y2: y2, kind: "right",
					key1: null, key2: null, next: null, prev: null, used: false });
				edges.push({ x1: spans[i + 1], y1: y2, x2: spans[i], y2: y2, kind: "bottom",
					key1: null, key2: null, next: null, prev: null, used: false });
				edges.push({ x1: spans[i], y1: y2, x2: spans[i], y2: y1, kind: "left",
					key1: null, key2: null, next: null, prev: null, used: false });
			}
			return edges;
		} else {
			// Main case: N rows, N > 1

			// First, emit the top edge(s) and verticals.
			var _spans = array[0].region.getRawSpans();
			var _y = array[0].minY;
			var _y2 = array[0].maxY;
			for (var _i = 0; _i < _spans.length; _i += 2) {
				edges.push({ x1: _spans[_i], y1: _y, x2: _spans[_i + 1], y2: _y, kind: "top",
					key1: null, key2: null, next: null, prev: null, used: false });
				edges.push({ x1: _spans[_i + 1], y1: _y, x2: _spans[_i + 1], y2: _y2, kind: "right",
					key1: null, key2: null, next: null, prev: null, used: false });
				edges.push({ x1: _spans[_i], y1: _y2, x2: _spans[_i], y2: _y, kind: "left",
					key1: null, key2: null, next: null, prev: null, used: false });
			}

			// Now handle the interior rows.
			for (var rowIndex = 1, numRows = array.length; rowIndex < numRows; rowIndex++) {

				_y = array[rowIndex].minY;
				_y2 = array[rowIndex].maxY;

				if (_y > array[rowIndex - 1].maxY) {
					// Emit bottom edges for the previous row verbatim, since it doesn't touch this row.
					for (var _i2 = 0; _i2 < _spans.length; _i2 += 2) {
						edges.push({ x1: _spans[_i2 + 1], y1: array[rowIndex - 1].maxY, x2: _spans[_i2], y2: array[rowIndex - 1].maxY, kind: "bottom",
							key1: null, key2: null, next: null, prev: null, used: false });
					}

					// Emit top edges for this row verbatim, since it doesn't touch the previous row.
					_spans = array[rowIndex].region.getRawSpans();
					for (var _i3 = 0; _i3 < _spans.length; _i3 += 2) {
						edges.push({ x1: _spans[_i3], y1: _y, x2: _spans[_i3 + 1], y2: _y, kind: "top",
							key1: null, key2: null, next: null, prev: null, used: false });
					}
				} else {
					// Emit bottom edges for the previous row by subtracting away this row.
					var interiorEdges = array[rowIndex - 1].region.subtract(array[rowIndex].region);
					_spans = interiorEdges.getRawSpans();
					for (var _i4 = 0; _i4 < _spans.length; _i4 += 2) {
						edges.push({ x1: _spans[_i4 + 1], y1: _y, x2: _spans[_i4], y2: _y, kind: "bottom",
							key1: null, key2: null, next: null, prev: null, used: false });
					}

					// Emit top edges for this row by subtracting away the previous row.
					interiorEdges = array[rowIndex].region.subtract(array[rowIndex - 1].region);
					_spans = interiorEdges.getRawSpans();
					for (var _i5 = 0; _i5 < _spans.length; _i5 += 2) {
						edges.push({ x1: _spans[_i5], y1: _y, x2: _spans[_i5 + 1], y2: _y, kind: "top",
							key1: null, key2: null, next: null, prev: null, used: false });
					}
				}

				// Emit verticals everywhere on this row.
				_spans = array[rowIndex].region.getRawSpans();
				for (var _i6 = 0; _i6 < _spans.length; _i6 += 2) {
					edges.push({ x1: _spans[_i6 + 1], y1: _y, x2: _spans[_i6 + 1], y2: _y2, kind: "right",
						key1: null, key2: null, next: null, prev: null, used: false });
					edges.push({ x1: _spans[_i6], y1: _y2, x2: _spans[_i6], y2: _y, kind: "left",
						key1: null, key2: null, next: null, prev: null, used: false });
				}
			}

			// Finally, emit the bottom edge(s) for the last row.
			for (var _i7 = 0; _i7 < _spans.length; _i7 += 2) {
				edges.push({ x1: _spans[_i7 + 1], y1: _y2, x2: _spans[_i7], y2: _y2, kind: "bottom",
					key1: null, key2: null, next: null, prev: null, used: false });
			}
		}

		return edges;
	},


	/**
  * Make a lookup table that finds edges quickly (O(1)) by either endpoint, and set up the
  * edges as a linked list so it's easy to quickly (O(1)) find any un-consumed edge.
  */
	makeEdgeTable = function makeEdgeTable(edges) {
		var table = {};

		for (var i = 0, l = edges.length; i < l; i++) {
			var edge = edges[i];

			edge.key1 = edge.x1 + "," + edge.y1;
			edge.key2 = edge.x2 + "," + edge.y2;

			edge.prev = i > 0 ? edges[i - 1] : null;
			edge.next = i < l - 1 ? edges[i + 1] : null;

			// We only add the 'start' endpoint to the lookup table, because that's
			// the only point we want to follow to.
			if (!(edge.key1 in table)) table[edge.key1] = [edge];else table[edge.key1].push(edge);
		}

		return table;
	},


	/**
  * Make the windings, clockwise polygons that are formed from adjacent edges.
  */
	makeWindings = function makeWindings(edges, table) {
		// Algorithm:
		//
		// Starting with a top edge, follow its endpoints clockwise until we reach that same
		// start edge.  Wherever duplicate points are found, prefer following top->right,
		// right->bottom, bottom->left, and left->top.  Remove each edge from the source set
		// as we follow it.  When we reach the start edge, if there are edges left, repeat the
		// same whole algorithm until no edges are left.

		var allWindings = [];

		// This will be the linked-list of all unconsumed edges.
		var firstEdge = edges[0],
		    lastEdge = edges[edges.length - 1];

		// Consume an edge:  Remove it from the list, and mark it as 'used'.
		var consumeEdge = function consumeEdge(edge) {
			if (edge.next) edge.next.prev = edge.prev;else lastEdge = edge.prev;

			if (edge.prev) edge.prev.next = edge.next;else firstEdge = edge.next;

			edge.used = true;
		};

		// Find the next edge to follow given a set of possible matches.
		var findBestPossibleEdge = function findBestPossibleEdge(edge, possibleEdges) {

			// Easy degenerate case:  If there's only one edge, take it.
			if (possibleEdges.length === 1 && !possibleEdges.used) return possibleEdges[0];

			// First, prefer following top->right, right->bottom, bottom->left, and left->top,
			// if there's a matching edge.
			for (var i = 0, l = possibleEdges.length; i < l; i++) {
				if (possibleEdges[i].used) continue;
				switch (edge.kind) {
					case 'top':
						if (possibleEdges[i].kind === 'right') return possibleEdges[i];
						break;
					case 'right':
						if (possibleEdges[i].kind === 'bottom') return possibleEdges[i];
						break;
					case 'bottom':
						if (possibleEdges[i].kind === 'left') return possibleEdges[i];
						break;
					case 'left':
						if (possibleEdges[i].kind === 'top') return possibleEdges[i];
						break;
				}
			}

			// We can't follow our preferred direction, so just take whatever's available.
			for (var _i8 = 0, _l = possibleEdges.length; _i8 < _l; _i8++) {
				if (possibleEdges[_i8].used) continue;
				return possibleEdges[_i8];
			}

			// Shouldn't get here.
			throw new regionError("Edge generation failure.");
		};

		// Main loop:  We do this until we run out of edges.  Each iteration of the loop
		// will generate one whole polygon.  This whole thing is fairly complex-looking,
		// but it will run in O(n) time.
		while (firstEdge) {

			var winding = [];

			// First, find any top edge.  This *could* be up to O(n) in a pathological case, but
			// average time is O(1) because of how we generated the edges in the first place.
			var startEdge = firstEdge;
			while (startEdge.kind !== 'top') {
				startEdge = startEdge.next;
			}

			// Consume and emit the start edge.
			consumeEdge(startEdge);
			winding.push({ x: startEdge.x1, y: startEdge.y1 });

			// Now walk forward from the current edge, following its end point to successive
			// start points until we reach the startEdge's start point.
			var currentEdge = startEdge;
			var prevX = startEdge.x1,
			    prevPrevX = null;
			while (currentEdge.key2 !== startEdge.key1) {

				// First, find the set of possible edges to follow, which should be nonempty.
				var possibleEdges = table[currentEdge.key2];

				// Move to the edge that is the best one to follow.
				currentEdge = findBestPossibleEdge(currentEdge, possibleEdges);

				// Consume it, now that we found it.
				consumeEdge(currentEdge);

				// Emit the next point in the winding.
				if (currentEdge.x1 === prevX && prevX === prevPrevX) {
					// This vertical edge was preceded by another vertical edge, so this edge piece extends it.
					winding[winding.length - 1].y = currentEdge.y1;
				} else {
					winding.push({ x: currentEdge.x1, y: currentEdge.y1 });
				}

				// Record where we've been so we know if we have to extend this edge.
				prevPrevX = prevX;
				prevX = currentEdge.x1;
			}

			// If the last edge was vertical, and it generated an extra point between its
			// start and the winding's first point, remove its extra point.
			if (winding[0].x === prevX && prevX === prevPrevX) {
				winding.pop();
			}

			// Finished a whole polygon.
			allWindings.push(winding);
		}

		return allWindings;
	},


	/**
  * Calculate a minimal set of nonoverlapping nonadjoining clockwise polygons that describe this region.
  * The result will be an array of arrays of points, like this:
  *     [
  *         [{x:1, y:2}, {x:3, y:2}, {x:3, y:6}, {x:1, y:6}],    // Polygon 1
  *         [{x:7, y:5}, {x:8, y:5}, {x:8, y:8}, {x:10, y:8}, {x:10, y:9}, {x:7, y:9}]    // Polygon 2
  *     ]
  */
	makePath = function makePath(array) {
		if (!array.length) return [];
		var edges = generateEdges(array);
		var table = makeEdgeTable(edges);
		var windings = makeWindings(edges, table);
		return windings;
	},


	//---------------------------------------------------------------------------------------------
	// Region miscellaneous support.

	/**
  * Calculate a new region whose coordinates have all been translated/scaled by the given amounts.
  */
	transformData = function transformData(array, ratioX, ratioY, deltaX, deltaY) {
		deltaX = Number(deltaX);
		deltaY = Number(deltaY);
		if (!(nInf < deltaX && deltaX < pInf) || !(nInf < deltaY && deltaY < pInf)) // Catches other NaNs as well as infinities.
			throw new regionError("Invalid translation delta");
		ratioX = Number(ratioX);
		ratioY = Number(ratioY);
		if (!(nInf < ratioX && ratioX < pInf) || ratioX === 0 || !(nInf < ratioY && ratioY < pInf) || ratioY === 0) // Catches other NaNs as well as infinities.
			throw new regionError("Invalid scale ratio");

		var newArray = [];
		for (var i = 0, l = array.length; i < l; i++) {
			var row = array[i];
			newArray[i] = {
				region: row.region.transform(ratioX, deltaX),
				minY: row.minY * ratioY + deltaY,
				maxY: row.maxY * ratioY + deltaY
			};
		}

		return newArray;
	},


	/**
  * Determine if the bounding rectangles of each region actually overlap.  If they
  * don't overlap, we can often treat region operations as special degenerate cases.
  * This runs in O(1) time.
  */
	doBoundsOverlap = function doBoundsOverlap(data1, data2) {
		return !(data1.minX > data2.maxX || data1.maxX < data2.minX || data1.minY > data2.maxY || data1.maxY < data2.minY);
	},
	    cannotConstructMessage = "Cannot construct a Region2D from ",
	    invalidRectangleDataMessage = cannotConstructMessage + "invalid rectangle data.",
	    invalidRectangleSizeMessage = cannotConstructMessage + "a rectangle of zero or negative size.",


	/**
  * Make region data from a single rectangle, in one of the four major rectangle forms:
  *     - An object with { x:, y:, width:, height: } properties.
  *     - An object with { left:, top:, right:, bottom: } properties.
  *     - An array with [x, y, width, height] values.
  *     - A DOM element's bounding box.
  * 
  * This is fairly straightforward, and runs in O(1) time.
  */
	makeRegionDataFromOneRect = function makeRegionDataFromOneRect(rect) {

		// Calculate the actual rectangle coordinates from whatever object was passed in.
		var minX = void 0,
		    maxX = void 0,
		    minY = void 0,
		    maxY = void 0;
		if (typeof HTMLElement !== 'undefined' && rect instanceof HTMLElement) {
			var clientRect = rect.getBoundingClientRect();
			minX = window.scrollX + clientRect.left, minY = window.scrollY + clientRect.top;
			maxX = window.scrollX + clientRect.right, maxY = window.scrollY + clientRect.bottom;
		} else if (isArray(rect)) {
			if (rect.length !== 4) {
				throw new regionError(invalidRectangleDataMessage);
			}
			minX = Number(rect[0]), minY = Number(rect[1]);
			maxX = Number(rect[2]), maxY = Number(rect[3]);
		} else if ("left" in rect) {
			minX = Number(rect.left), minY = Number(rect.top);
			maxX = Number(rect.right), maxY = Number(rect.bottom);
		} else if ("x" in rect) {
			minX = Number(rect.x), minY = Number(rect.y);
			maxX = minX + Number(rect.width), maxY = minY + Number(rect.height);
		} else {
			throw new regionError(invalidRectangleDataMessage);
		}

		// Validate the rectangle data.
		if (maxX <= minX || maxY <= minY) {
			throw new regionError(invalidRectangleSizeMessage);
		}

		// Construct the new row containing that rectangle.
		var region1D = new Region1D([minX, maxX]);

		// Now make the actual region data for this single-rect region.
		var data = {
			array: [{
				region: region1D,
				minY: minY,
				maxY: maxY
			}],
			count: 1,
			minX: minX,
			minY: minY,
			maxX: maxX,
			maxY: maxY,
			hash: region1D.getHashCode()
		};

		return data;
	},


	/**
  * Construct an empty region consisting of no rectangles at all.
  */
	makeEmptyRegionData = function makeEmptyRegionData() {
		return {
			array: [],
			count: 0,
			minX: pInf,
			minY: pInf,
			maxX: nInf,
			maxY: nInf,
			hash: 0
		};
	},
	    rowDataErrorMessage = "Invalid row data for row ",


	/**
  * Construct a region from raw band data.  This simply checks the band data for correctness,
  * and then fills in the appropriate metadata.  This runs in O(n) time with respect to the
  * number of bands.
  */
	makeDataFromRows = function makeDataFromRows(bands) {

		// These will collect all the statistical metadata about the region.
		var prevMax = nInf;
		var count = 0;
		var minX = pInf,
		    maxX = nInf;
		var hash = 0;

		// Clone the band data, validate it, and collect the metadata.  This is O(n) with respect
		// to the number of bands; the number of rectangles per band is irrelevant.
		var array = [];
		for (var i = 0, l = bands.length; i < l; i++) {

			// Check the band.
			var band = bands[i];
			if (band.minY < prevMax || band.minY >= band.maxY || !(band.region instanceof Region1D)) {
				throw new RegionError(rowDataErrorMessage + i);
			}

			// Push a cloned copy of its data.
			array.push({
				region: band.region,
				minY: band.minY,
				maxY: band.maxY
			});

			// Collect statistics about the band.
			var rowCount = band.region.getCount();
			if (!rowCount) {
				throw new RegionError(rowDataErrorMessage + i);
			}
			count += rowCount;

			// Update the region's X boundaries.
			var bounds = band.region.getBounds();
			if (bounds.min < minX) minX = bounds.min;
			if (bounds.max > maxX) maxX = bounds.max;

			// Update the region's hash code (for fast inequality tests).
			hash *= 23;
			hash += band.region.getHashCode() | 0;
			hash &= ~0;

			prevMax = band.maxY;
		}

		// Create the region data from the resulting rows and the metadata.
		return {
			array: array,
			count: count,
			minX: minX,
			minY: array.length ? array[0].minY : pInf,
			maxX: maxX,
			maxY: array.length ? array[array.length - 1].maxY : nInf,
			hash: hash
		};
	},


	/**
  * Create a simple rectangle from the given region's internal bounding rect.
  */
	getBoundsFromData = function getBoundsFromData(data) {
		return {
			x: data.minX,
			y: data.minY,
			width: data.maxX - data.minX,
			height: data.maxY - data.minY,
			left: data.minX,
			top: data.minY,
			right: data.maxX,
			bottom: data.maxY
		};
	},


	/**
  * Get a copy of the raw row data.
  */
	_getRawRows = function _getRawRows(srcArray) {
		var destArray = [];
		for (var i = 0, l = srcArray.length; i < l; i++) {
			var src = srcArray[i];
			destArray.push({
				minY: src.minY,
				maxY: src.maxY,
				region: src.region
			});
		}
		return destArray;
	},


	/**
  * Get all of the rectangle data for this entire region.
  */
	makeRects = function makeRects(array) {
		var result = [];
		for (var i = 0, l = array.length; i < l; i++) {
			var row = array[i];
			row.region.getAsRects(row.minY, row.maxY, result);
		}
		return result;
	},


	/**
  * Determine whether this region stretches to infinity in any direction.
  */
	_isInfinite = function _isInfinite(data) {
		return data.minX === nInf || data.minY === nInf || data.maxX === pInf || data.maxY === pInf;
	},


	/**
  * Compare the Region1D data found in each array instance to each other for equality.
  */
	arrayEquals = function arrayEquals(array1, array2) {
		if (array1.length != array2.length) return false;
		for (var i = 0, l = array1.length; i < l; i++) {
			if (array1[i].minY !== array2[i].minY || array1[i].maxY !== array2[i].maxY) return false;
			if (!array1[i].region.equals(array2[i].region)) return false;
		}
		return true;
	},


	/**
  * Determine if the data of region1 intersects the data of region2, and do so more efficiently
  * than simply performing "!a.intersect(b).isEmpty()".
  */
	doesIntersectData = function doesIntersectData(data1, data2) {
		// TODO: Implement this better than the quick-and-dirty solution below.  Ideally,
		//    this should just test the data and early-out on the first hit, rather than
		//    actually *doing* all the work and then discarding the result.
		return !!intersectData(data1.array, data2.array).array.length;
	},


	/**
  * Determine if the given point lies within the given region data.  This first performs
  * some easy boundary checks, then efficiently finds the matching row (if any), and then
  * invokes Region1D.isPointIn() to efficiently answer the question for real.  This runs in
  * O(lg n) time, where 'n' is the number of rectangles in the region.
  */
	isPointInData = function isPointInData(data, x, y) {
		var array = data.array;

		// It can't be in the empty set.
		if (!array.length) return false;

		// If it's outside the bounds, it's definitely not in.
		if (y < data.minY || y > data.maxY || x < data.minX || x > data.maxX) return false;

		if (array.length <= 5) {
			// Spin over all the rows in a simple linear search.
			for (var i = 0, l = array.length; i < l; i++) {
				if (y >= array[i].minY && y < array[i].maxY) {
					// Found the row.
					return array[i].region.isPointIn(x);
				}
			}
			return false;
		} else {
			// Binary search to find the row that y is within.
			var start = 0,
			    end = array.length;
			while (start < end) {
				var midpt = (start + end) / 2 & ~0;
				var row = array[midpt];
				if (y >= row.minY && y < row.maxY) {
					// Found the row, so see if 'x' lies within its spans.
					return row.region.isPointIn(x);
				} else if (y < row.minY) {
					end = midpt;
				} else {
					start = midpt + 1;
				}
			}
			return false;
		}
	},


	/**
  * Check to ensure that the given object is actually a Region2D, and abort if it is not.
  */
	verifyRegion2DType = function verifyRegion2DType(obj) {
		if (!(obj instanceof Region2D)) {
			throw new regionError("Object must be a Region2D instance.");
		}
	},


	//---------------------------------------------------------------------------------------------
	// Public construction interface.

	/**
  * A special private object used to flag internal constructions in such a way that
  * external callers' data must be validated, but internal data can skip those checks.
  */
	privateKey = {},


	/**
  * Access the internal data, if this is an allowed thing to do.
  */
	getData = function getData(region) {
		return region._opaque(privateKey);
	};

	/**
  * Construct a 2-D region either from either nothing or from the given rectangle.
  * 
  * Usage:
  *     var empty = new Region2D();
  *     var rectRegion = new Region2D(rect);
  * 
  * The rectangle may be expressed as any of the following three forms:
  *     - An object with { x:, y:, width:, height: } properties.
  *     - An object with { left:, top:, right:, bottom: } properties.
  *     - An array with [x, y, width, height] values.
  * 
  * Alternative internal invocation:
  *     var region = new Region2D(regionData, privateKey);
  */
	function Region2D(rect, key) {
		var data = key === privateKey ? rect : typeof rect !== 'undefined' ? makeRegionDataFromOneRect(rect) : makeEmptyRegionData();

		this._opaque = makeProtectedData(data, privateKey);
	};

	/**
  * The region's prototype contains helpers that simply invoke the private operations
  * to do all the hard work.
  */
	Region2D.prototype = {
		union: function union(other) {
			verifyRegion2DType(other);
			var data = getData(this),
			    otherData = getData(other);
			return new Region2D(unionData(data.array, otherData.array), privateKey);
		},
		intersect: function intersect(other) {
			verifyRegion2DType(other);
			var data = getData(this),
			    otherData = getData(other);
			if (!doBoundsOverlap(data, otherData)) return empty;
			return new Region2D(intersectData(data.array, otherData.array), privateKey);
		},
		subtract: function subtract(other) {
			verifyRegion2DType(other);
			var data = getData(this),
			    otherData = getData(other);
			if (!doBoundsOverlap(data, otherData)) return this;
			return new Region2D(subtractData(data.array, otherData.array), privateKey);
		},
		xor: function xor(other) {
			verifyRegion2DType(other);
			var data = getData(this),
			    otherData = getData(other);
			return new Region2D(xorData(data.array, otherData.array), privateKey);
		},
		not: function not() {
			// Lazy implementation of 'not': Simply 'xor' with an infinite region.
			// A better implementation would take advantage of the efficient Region1D#not() method.
			var data = getData(this),
			    otherData = getData(infinite);
			return new Region2D(xorData(data.array, otherData.array), privateKey);
		},
		transform: function transform(scaleX, scaleY, offsetX, offsetY) {
			var data = getData(this);
			return new Region2D(makeDataFromRows(transformData(data.array, scaleX, scaleY, offsetX, offsetY)), privateKey);
		},
		translate: function translate(offsetX, offsetY) {
			var data = getData(this);
			return new Region2D(makeDataFromRows(transformData(data.array, 1.0, 1.0, offsetX, offsetY)), privateKey);
		},
		scale: function scale(scaleX, scaleY) {
			var data = getData(this);
			return new Region2D(makeDataFromRows(transformData(data.array, scaleX, scaleY, 0, 0)), privateKey);
		},
		isEmpty: function isEmpty() {
			return !getData(this).array.length;
		},
		isInfinite: function isInfinite() {
			return _isInfinite(getData(this));
		},
		isFinite: function isFinite() {
			return !_isInfinite(getData(this));
		},
		isRectangular: function isRectangular() {
			return getData(this).count === 1;
		},
		doesIntersect: function doesIntersect(other) {
			verifyRegion2DType(other);
			return doesIntersectData(getData(this), getData(other));
		},
		isPointIn: function isPointIn(x, y) {
			return isPointInData(getData(this), Number(x), Number(y));
		},
		equals: function equals(other) {
			verifyRegion2DType(other);
			var data = getData(this),
			    otherData = getData(other);
			if (data === otherData) return true;
			if (data.hash !== otherData.hash || data.count !== otherData.count) return false;
			return arrayEquals(data.array, otherData.array);
		},
		getCount: function getCount() {
			return getData(this).count;
		},
		getRects: function getRects() {
			return makeRects(getData(this).array);
		},
		getRawRows: function getRawRows() {
			return _getRawRows(getData(this).array);
		},
		getBounds: function getBounds() {
			return getBoundsFromData(getData(this));
		},
		getPath: function getPath() {
			return makePath(getData(this).array);
		},
		getHashCode: function getHashCode() {
			return getData(this).hash;
		}
	};

	/**
  * A reusable infinite instance.
  */
	Region2D.infinite = infinite = new Region2D([nInf, nInf, pInf, pInf]);

	/**
  * A reusable empty instance.
  */
	Region2D.empty = empty = new Region2D();

	/**
  * Static helper function for creating complex regions from arrays of rectangles.
  */
	Region2D.fromRects = function (rects) {
		if (!rects.length) return empty;
		var region = new Region2D(rects[0]);
		for (var i = 1, l = rects.length; i < l; i++) {
			region = region.union(new Region2D(rects[i]));
		}
		return region;
	};

	/**
  * Static helper function for creating complex regions from pre-constructed row data.
  * This is the fastest way to create a complex region, as it runs in O(n) time (with
  * respect to the number of rows), but it has strict requirements on the shape of the
  * row data.
  * 
  * @param rows {Array} - An array of objects, where each object describes a row of the
  *    region.  The row objects must have the properties 'region' {Region1D}, 'minY' {Number},
  *    and 'maxY' {Number}.  The 'maxY' of each row must be strictly greater than the 'minY'
  *    of that row, and the 'minY' of each row must be greater than or equal to the 'maxY' of
  *    the previous row.  Each row's Region1D must also be nonempty.
  */
	Region2D.fromRawRows = function (rows) {
		return new Region2D(makeDataFromRows(rows), privateKey);
	};

	return Region2D;
}();
