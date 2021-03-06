import 'plugins/kibi_core/management/sections/kibi_datasources/styles/datasources_editor.less';
import 'plugins/kibi_core/management/sections/kibi_datasources/services/_saved_datasource';
import 'plugins/kibi_core/management/sections/kibi_datasources/services/saved_datasources';
import 'ui/kibi/components/query_engine_client/query_engine_client';
import 'ui/kibi/directives/kibi_validate';
import SetDatasourceSchemaProvider from 'plugins/kibi_core/management/sections/kibi_datasources/lib/set_datasource_schema';
import template from 'plugins/kibi_core/management/sections/kibi_datasources/index.html';
import kibiUtils from 'kibiutils';
import uiRoutes from 'ui/routes';
import { uiModules } from 'ui/modules';
import { jdbcDatasourceTranslate } from 'plugins/kibi_core/management/sections/kibi_datasources/services/jdbc_datasource_translate';

uiRoutes
.when('/management/siren/datasources', {
  template,
  reloadOnSearch: false,
  resolve: {
    datasource: function (savedDatasources) {
      return savedDatasources.get();
    },
    isNew: function () {
      return true;
    }
  }
})
.when('/management/siren/datasources/:id?', {
  template,
  reloadOnSearch: false,
  resolve: {
    datasource: function ($route, courier, savedDatasources, jdbcDatasources) {
      // first try to get it from _vanguard/connector
      return jdbcDatasources.get($route.current.params.id)
      .then(datasource => {
        return jdbcDatasourceTranslate.jdbcDatasourceToSavedDatasource(datasource);
      })
      .catch(err => {
        return savedDatasources.get($route.current.params.id)
        .catch(courier.redirectWhenMissing({
          datasource: '/management/siren/datasources'
        }));
      });
    },
    isNew: function () {
      return false;
    }
  }
});

function controller(Private, $window, $scope, $route, kbnUrl, createNotifier, queryEngineClient, $element, kibiWarnings, jdbcDatasources) {
  const setDatasourceSchema = Private(SetDatasourceSchemaProvider);
  const notify = createNotifier({
    location: 'Datasources Configuration Editor'
  });
  const datasource = $scope.datasource = $route.current.locals.datasource;
  $scope.isNew = $route.current.locals.isNew;

  $scope.isValid = function () {
    return $element.find('form[name="objectForm"]').hasClass('ng-valid');
  };

  $scope.saveObject = function () {

    if (datasource.datasourceType === 'sql_jdbc_new') {
      const d = jdbcDatasourceTranslate.savedDatasourceToJdbcDatasource(datasource);
      return jdbcDatasources.save(d).then(() => {
        notify.info('Datasource ' + d._id + ' successfully saved');
        kbnUrl.change('management/siren/datasources/' + d._id);
      });
    }

    if (kibiWarnings.datasource_encryption_warning) {
      let encrypted = false;
      for (let s = 0; s < datasource.schema.length; s++) {
        const field = datasource.schema[s];
        if (field.encrypted) {
          encrypted = true;
          break;
        }
      }
      if (encrypted && !$window.confirm('You haven\'t set a custom encryption key;' +
          ' are you sure you want to save this datasource?')) {
        return;
      }
    }

    // old jdbc datasources
    if (kibiUtils.isJDBC(datasource.datasourceType)) {
      const msg = 'Changes in a JDBC datasource requires the application to be restarted. ' +
        'Please restart Kibi and do not forget to set kibi_core.load_jdbc to true.';
      notify.warning(msg);
    }

    if (datasource.datasourceType === kibiUtils.DatasourceTypes.tinkerpop3) {
      const datasourceUrl = datasource.datasourceParams.url;
      const baseUrl = datasourceUrl.replace(/\/graph\/query(Batch)?/, '');

      queryEngineClient.gremlinPing(baseUrl).then(function (response) {
        if (response.data.error) {
          notify.warning('Kibi Gremlin Server not available at this address: ' + baseUrl + '. Please check the configuration');
        } else {
          _saveDatasource(datasource);
        }
      })
      .catch(function (err) {
        notify.warning('Kibi Gremlin Server not available at this address: ' + baseUrl + '. Please check the configuration');
      });
    } else {
      _saveDatasource(datasource);
    }
  };

  function _saveDatasource(datasource) {
    // make sure that any parameter which does not belong to the schema
    // is removed from datasourceParams
    for (const prop in datasource.datasourceParams) {
      if (datasource.datasourceParams.hasOwnProperty(prop)) {
        let remove = true;
        for (let j = 0; j < datasource.schema.length; j++) {
          if (datasource.schema[j].name === prop) {
            remove = false;
            break;
          }
        }
        if (remove) {
          delete datasource.datasourceParams[prop];
        }
      }
    }

    datasource.save().then(function (datasourceId) {
      if (datasourceId) {
        $scope.isNew = false;
        notify.info('Datasource ' + datasource.title + ' successfully saved');
        queryEngineClient.clearCache().then(function () {
          kbnUrl.change('management/siren/datasources/' + datasourceId);
        });
      }
    });
  }

  $scope.newObject = function () {
    kbnUrl.change('management/siren/datasources', {});
  };

  $scope.$watch('datasource.datasourceType', function () {
    // here reinit the datasourceDef
    if (datasource.datasourceType === 'sql_jdbc_new' && datasource.title === 'New saved datasource') {
      datasource.title = '';
    }

    setDatasourceSchema(datasource);
  });

  // currently supported only for sql_jdbc_new
  $scope.testConnection = function () {
    jdbcDatasources.validate(jdbcDatasourceTranslate.savedDatasourceToJdbcDatasource(datasource))
    .then(res => {
      $scope.connectionStatus = res;
    })
    .catch(err => {
      $scope.connectionStatus = err;
    });
  };

  // expose some methods to the navbar buttons
  [ 'isValid', 'newObject', 'saveObject' ]
  .forEach(name => {
    $element.data(name, $scope[name]);
  });
}

uiModules
.get('apps/management', ['kibana'])
.controller('DatasourcesEditor', controller);
