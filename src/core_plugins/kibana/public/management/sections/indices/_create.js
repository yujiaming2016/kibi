import _ from 'lodash';
import { IndexPatternAuthorizationError, IndexPatternMissingIndices } from 'ui/errors'; // kibi: import auth error
import 'ui/directives/validate_index_name';
import 'ui/directives/auto_select_if_only_one';
import RefreshKibanaIndex from 'plugins/kibana/management/sections/indices/_refresh_kibana_index';
import uiRoutes from 'ui/routes';
import { uiModules } from 'ui/modules';
import createTemplate from 'plugins/kibana/management/sections/indices/_create.html';

uiRoutes
.when('/management/siren/index', {
  template: createTemplate
});

uiModules.get('apps/management')
.controller('managementIndicesCreate', function ($scope, kbnUrl, Private, createNotifier, indexPatterns, es, config, Promise, $translate) {
  const notify = createNotifier();
  const refreshKibanaIndex = Private(RefreshKibanaIndex);
  const intervals = indexPatterns.intervals;
  let samplePromise;

  // this and child scopes will write pattern vars here
  const index = $scope.index = {
    name: config.get('indexPattern:placeholder'),
    isTimeBased: true,
    nameIsPattern: false,
    expandable: false,
    sampleCount: 5,
    nameIntervalOptions: intervals,

    fetchFieldsError: $translate.instant('KIBANA-LOADING')
  };

  index.nameInterval = _.find(index.nameIntervalOptions, { name: 'daily' });
  index.timeField = null;

  $scope.canExpandIndices = function () {
    // to maximize performance in the digest cycle, move from the least
    // expensive operation to most
    return index.isTimeBased && !index.nameIsPattern && _.includes(index.name, '*');
  };

  $scope.refreshFieldList = function () {
    const timeField = index.timeField;
    fetchFieldList().then(function (results) {
      if (timeField) {
        updateFieldListAndSetTimeField(results, timeField.name);
      } else {
        updateFieldList(results);
      }
    });
  };

  $scope.createIndexPattern = function () {
    // get an empty indexPattern to start
    indexPatterns.get()
    .then(function (indexPattern) {
      // set both the id and title to the index index
      indexPattern.id = indexPattern.title = index.name;
      if (index.isTimeBased) {
        indexPattern.timeFieldName = index.timeField.name;
        if (index.nameIsPattern) {
          indexPattern.intervalName = index.nameInterval.name;
        }
      }

      if (!index.expandable && $scope.canExpandIndices()) {
        indexPattern.notExpandable = true;
      }

      // fetch the fields
      return indexPattern.create()
      .then(function (id) {
        if (id) {
          refreshKibanaIndex().then(function () {
            // kibi: do not try to set the default index pattern automatically
            // as user might not have permissions to do it

            indexPatterns.cache.clear(indexPattern.id);
            kbnUrl.change('/management/siren/indices/' + indexPattern.id);
          });
        }
      });

      // refreshFields calls save() after a successfull fetch, no need to save again
      // .then(function () { indexPattern.save(); })
    })
    .catch(function (err) {
      if (err instanceof IndexPatternMissingIndices) {
        notify.error($translate.instant('KIBANA-NO_INDICES_MATCHING_PATTERN'));
      }
      // kibi: warn if the index pattern cannot be retrieved because of an authorization error
      else if (err instanceof IndexPatternAuthorizationError) {
        notify.warning('Could not locate indices matching the pattern, access was forbidden.');
      }
      // kibi: end
      else notify.fatal(err);
    });
  };


  $scope.$watchMulti([
    'index.isTimeBased',
    'index.nameIsPattern',
    'index.nameInterval.name'
  ], function (newVal, oldVal) {
    const isTimeBased = newVal[0];
    const nameIsPattern = newVal[1];
    const newDefault = getPatternDefault(newVal[2]);
    const oldDefault = getPatternDefault(oldVal[2]);

    if (index.name === oldDefault) {
      index.name = newDefault;
    }

    if (!isTimeBased) {
      index.nameIsPattern = false;
    }

    if (!nameIsPattern) {
      delete index.nameInterval;
      delete index.timeField;
    } else {
      index.nameInterval = index.nameInterval || intervals.byName.days;
      index.name = index.name || getPatternDefault(index.nameInterval);
    }
  });

  $scope.moreSamples = function (andUpdate) {
    index.sampleCount += 5;
    if (andUpdate) updateSamples();
  };

  $scope.$watchMulti([
    'index.name',
    'index.nameInterval'
  ], function (newVal, oldVal) {
    let lastPromise;
    resetIndex();
    samplePromise = lastPromise = updateSamples()
    .then(function () {
      promiseMatch(lastPromise, function () {
        index.samples = null;
        index.patternErrors = [];
      });
    })
    .catch(function (errors) {
      promiseMatch(lastPromise, function () {
        index.existing = null;
        index.patternErrors = errors;
      });
    })
    .finally(function () {
      // prevent running when no change happened (ie, first watcher call)
      if (!_.isEqual(newVal, oldVal)) {
        fetchFieldList().then(function (results) {
          if (lastPromise === samplePromise) {
            updateFieldList(results);
            samplePromise = null;
          }
        });
      }
    });
  });

  $scope.$watchMulti([
    'index.isTimeBased',
    'index.sampleCount'
  ], $scope.refreshFieldList);

  function updateSamples() {
    const patternErrors = [];

    if (!index.nameInterval || !index.name) {
      return Promise.resolve();
    }

    const pattern = mockIndexPattern(index);

    return indexPatterns.mapper.getIndicesForIndexPattern(pattern)
    .catch(function (err) {
      if (err instanceof IndexPatternMissingIndices) return;
      // kibi: return on authorization errors
      if (err instanceof IndexPatternAuthorizationError) return;
      // kibi: end
      notify.error(err);
    })
    .then(function (existing) {
      const all = _.get(existing, 'all', []);
      const matches = _.get(existing, 'matches', []);
      if (all.length) {
        index.existing = {
          class: 'success',
          all: all,
          matches: matches,
          matchPercent: Math.round((matches.length / all.length) * 100) + '%',
          failures: _.difference(all, matches)
        };
        return;
      }

      patternErrors.push($translate.instant('KIBANA-PATTERN_DOES_NOT_MATCH_EXIST_INDICES'));
      const radius = Math.round(index.sampleCount / 2);
      const samples = intervals.toIndexList(index.name, index.nameInterval, -radius, radius);

      if (_.uniq(samples).length !== samples.length) {
        patternErrors.push($translate.instant('KIBANA-INVALID_NON_UNIQUE_INDEX_NAME_CREATED'));
      } else {
        index.samples = samples;
      }

      throw patternErrors;
    });
  }

  function fetchFieldList() {
    index.dateFields = index.timeField = index.listUsed = null;
    const useIndexList = index.isTimeBased && index.nameIsPattern;
    let fetchFieldsError;
    let dateFields;

    // we don't have enough info to continue
    if (!index.name) {
      fetchFieldsError = $translate.instant('KIBANA-SET_INDEX_NAME_FIRST');
      return;
    }

    if (useIndexList && !index.nameInterval) {
      fetchFieldsError = $translate.instant('KIBANA-INTERVAL_INDICES_POPULATED');
      return;
    }

    return indexPatterns.mapper.clearCache(index.name)
    .then(function () {
      const pattern = mockIndexPattern(index);

      return indexPatterns.mapper.getFieldsForIndexPattern(pattern, {
        skipIndexPatternCache: true,
      })
      .catch(function (err) {
        if (err instanceof IndexPatternMissingIndices) {
          fetchFieldsError = $translate.instant('KIBANA-INDICES_MATCH_PATTERN');
          return [];
        }
        // kibi: notify authorization errors
        if (err instanceof IndexPatternAuthorizationError) {
          fetchFieldsError = 'Unable to fetch mapping, access to this index pattern was denied.';
          return [];
        }
        throw err;
      });
    })
    .then(function (fields) {
      if (fields.length > 0) {
        fetchFieldsError = null;
        dateFields = fields.filter(function (field) {
          return field.type === 'date';
        });
      }

      return {
        fetchFieldsError: fetchFieldsError,
        dateFields: dateFields
      };
    }, notify.fatal);
  }

  function updateFieldListAndSetTimeField(results, timeFieldName) {
    updateFieldList(results);

    if (!results.dateFields.length) {
      return;
    }

    const matchingTimeField = results.dateFields.find(field => field.name === timeFieldName);
    const defaultTimeField = results.dateFields[0];

    //assign the field from the results-list
    //angular recreates a new timefield instance, each time the list is refreshed.
    //This ensures the selected field matches one of the instances in the list.
    index.timeField = matchingTimeField ? matchingTimeField : defaultTimeField;
  }

  function updateFieldList(results) {
    index.fetchFieldsError = results.fetchFieldsError;
    index.dateFields = results.dateFields;
  }

  function promiseMatch(lastPromise, cb) {
    if (lastPromise === samplePromise) {
      cb();
    } else if (samplePromise != null) {
      // haven't hit the last promise yet, reset index params
      resetIndex();
    }
  }

  function resetIndex() {
    index.patternErrors = [];
    index.samples = null;
    index.existing = null;
    index.fetchFieldsError = $translate.instant('KIBANA-LOADING');
  }

  function getPatternDefault(interval) {
    switch (interval) {
      case 'hours':
        return '[logstash-]YYYY.MM.DD.HH';
      case 'days':
        return '[logstash-]YYYY.MM.DD';
      case 'weeks':
        return '[logstash-]GGGG.WW';
      case 'months':
        return '[logstash-]YYYY.MM';
      case 'years':
        return '[logstash-]YYYY';
      default:
        return 'logstash-*';
    }
  }

  function mockIndexPattern(index) {
    // trick the mapper into thinking this is an indexPattern
    return {
      id: index.name,
      intervalName: index.nameInterval
    };
  }
});
