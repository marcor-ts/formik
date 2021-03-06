import * as React from 'react';
import isEqual from 'react-fast-compare';
import deepmerge from 'deepmerge';
import { FormikProvider } from './connect';
import warning from 'tiny-warning';
import {
  FormikActions,
  FormikConfig,
  FormikErrors,
  FormikState,
  FormikTouched,
  FormikValues,
  FormikProps,
} from './types';
import {
  isEmptyChildren,
  isFunction,
  isNaN,
  isPromise,
  isString,
  isInputEvent,
  setIn,
  setNestedObjectValues,
  getActiveElement,
  getIn,
  makeCancelable,
} from './utils';

export class Formik<Values = FormikValues> extends React.Component<
  FormikConfig<Values>,
  FormikState<Values>
> {
  static defaultProps = {
    validateOnChange: true,
    validateOnBlur: true,
    isInitialValid: false,
    enableReinitialize: false,
  };

  initialValues: Values;
  didMount: boolean;
  hcCache: {
    [key: string]: (e: unknown | React.ChangeEvent<any>) => void;
  } = {};
  hbCache: {
    [key: string]: (e: any) => void;
  } = {};
  fields: {
    [field: string]: React.Component<any>;
  };
  validator: any;

  constructor(props: FormikConfig<Values>) {
    super(props);
    this.state = {
      values: props.initialValues || ({} as any),
      errors: {},
      touched: {},
      isSubmitting: false,
      isValidating: false,
      submitCount: 0,
      status: props.initialStatus,
    };
    this.didMount = false;
    this.fields = {};
    this.initialValues = props.initialValues || ({} as any);
    warning(
      !(props.component && props.render),
      'You should not use <Formik component> and <Formik render> in the same <Formik> component; <Formik render> will be ignored'
    );

    warning(
      !(props.component && props.children && !isEmptyChildren(props.children)),
      'You should not use <Formik component> and <Formik children> in the same <Formik> component; <Formik children> will be ignored'
    );

    warning(
      !(props.render && props.children && !isEmptyChildren(props.children)),
      'You should not use <Formik render> and <Formik children> in the same <Formik> component; <Formik children> will be ignored'
    );
  }

  registerField = (name: string, Comp: React.Component<any>) => {
    this.fields[name] = Comp;
  };

  unregisterField = (name: string) => {
    delete this.fields[name];
  };

  componentDidMount() {
    this.didMount = true;
  }

  componentWillUnmount() {
    // This allows us to prevent setting state on an
    // unmounted component. This can occur if Formik is in a modal, and submission
    // toggles show/hide, and validation of a blur field takes longer than validation
    // before a submit.
    // @see https://github.com/jaredpalmer/formik/issues/597
    // @see https://reactjs.org/blog/2015/12/16/ismounted-antipattern.html
    this.didMount = false;

    // Cancel validation on unmount.
    if (this.validator) {
      this.validator();
    }
  }

  componentDidUpdate(prevProps: Readonly<FormikConfig<Values>>) {
    // If the initialValues change, reset the form
    if (
      this.props.enableReinitialize &&
      !isEqual(prevProps.initialValues, this.props.initialValues)
    ) {
      this.initialValues = this.props.initialValues;
      // @todo refactor to use getDerivedStateFromProps?
      this.resetForm(this.props.initialValues);
    }
  }

  setErrors = (errors: FormikErrors<Values>) => {
    this.setState({ errors });
  };

  setTouched = (touched: FormikTouched<Values>) => {
    this.setState({ touched }, () => {
      if (this.props.validateOnBlur) {
        this.runValidations(this.state.values);
      }
    });
  };

  setValues = (values: FormikState<Values>['values']) => {
    this.setState({ values }, () => {
      if (this.props.validateOnChange) {
        this.runValidations(values);
      }
    });
  };

  setStatus = (status?: any) => {
    this.setState({ status });
  };

  setError = (error: any) => {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `Warning: Formik\'s setError(error) is deprecated and may be removed in future releases. Please use Formik\'s setStatus(status) instead. It works identically. For more info see https://github.com/jaredpalmer/formik#setstatus-status-any--void`
      );
    }
    this.setState({ error });
  };

  setSubmitting = (isSubmitting: boolean) => {
    if (this.didMount) {
      this.setState({ isSubmitting });
    }
  };

  /**
   * Run field level validation
   */
  validateField = (field: string): Promise<Object> => {
    this.setState({ isValidating: true });
    return this.runSingleFieldLevelValidation(
      field,
      getIn(this.state.values, field)
    ).then(error => {
      if (this.didMount) {
        this.setState({
          errors: setIn(this.state.errors, field, error),
          isValidating: false,
        });
      }
      return error;
    });
  };

  runSingleFieldLevelValidation = (
    field: string,
    value: void | string
  ): Promise<string> => {
    return new Promise(resolve =>
      resolve(this.fields[field].props.validate(value))
    ).then(x => x, e => e);
  };

  runFieldLevelValidations(
    values: FormikValues
  ): Promise<FormikErrors<Values>> {
    const fieldKeysWithValidation: string[] = Object.keys(this.fields).filter(
      f =>
        this.fields &&
        this.fields[f] &&
        this.fields[f].props.validate &&
        isFunction(this.fields[f].props.validate)
    );

    // Construct an array with all of the field validation functions
    const fieldValidations: Promise<string>[] =
      fieldKeysWithValidation.length > 0
        ? fieldKeysWithValidation.map(f =>
            this.runSingleFieldLevelValidation(f, getIn(values, f))
          )
        : [Promise.resolve('DO_NOT_DELETE_YOU_WILL_BE_FIRED')]; // use special case ;)

    return Promise.all(fieldValidations).then((fieldErrorsList: string[]) =>
      fieldErrorsList.reduce(
        (prev, curr, index) => {
          if (curr === 'DO_NOT_DELETE_YOU_WILL_BE_FIRED') {
            return prev;
          }
          if (!!curr) {
            prev = setIn(prev, fieldKeysWithValidation[index], curr);
          }
          return prev;
        },
        {} as FormikErrors<Values>
      )
    );
  }

  runValidateHandler(values: FormikValues): Promise<FormikErrors<Values>> {
    return new Promise(resolve => {
      const maybePromisedErrors = (this.props.validate as any)(values);
      if (maybePromisedErrors === undefined) {
        resolve({});
      } else if (isPromise(maybePromisedErrors)) {
        (maybePromisedErrors as Promise<any>).then(
          () => {
            resolve({});
          },
          errors => {
            resolve(errors);
          }
        );
      } else {
        resolve(maybePromisedErrors);
      }
    });
  }

  /**
   * Run validation against a Yup schema and optionally run a function if successful
   */
  runValidationSchema = (values: FormikValues) => {
    return new Promise(resolve => {
      const { validationSchema } = this.props;
      const schema = isFunction(validationSchema)
        ? validationSchema()
        : validationSchema;
      validateYupSchema(values, schema).then(
        () => {
          resolve({});
        },
        (err: any) => {
          resolve(yupToFormErrors(err));
        }
      );
    });
  };

  /**
   * Run all validations methods and update state accordingly
   */
  runValidations = (
    values: FormikValues = this.state.values
  ): Promise<FormikErrors<Values>> => {
    if (this.validator) {
      this.validator();
    }

    const [promise, cancel] = makeCancelable(
      Promise.all([
        this.runFieldLevelValidations(values),
        this.props.validationSchema ? this.runValidationSchema(values) : {},
        this.props.validate ? this.runValidateHandler(values) : {},
      ]).then(([fieldErrors, schemaErrors, handlerErrors]) => {
        return deepmerge.all<FormikErrors<Values>>(
          [fieldErrors, schemaErrors, handlerErrors],
          { arrayMerge }
        );
      })
    );
    this.validator = cancel;
    return promise
      .then((errors: FormikErrors<Values>) => {
        if (this.didMount) {
          this.setState(prevState => {
            if (!isEqual(prevState.errors, errors)) {
              return { errors };
            }
            return null; // abort the update
          });
        }
        return errors;
      })
      .catch(x => x);
  };

  handleChange = (
    eventOrPath: string | React.ChangeEvent<any>
  ): void | ((eventOrValue: unknown | React.ChangeEvent<any>) => void) => {
    // this function actually handles the change
    const executeChange = (
      eventOrValue: unknown | React.ChangeEvent<any>,
      maybePath?: string
    ) => {
      // To allow using handleChange with React Native (Web) or other UI libraries, we
      // allow for the first argument to be either a value or the standard change event.
      let field = maybePath;
      let value: unknown;
      if (isInputEvent(eventOrValue)) {
        const event = eventOrValue as React.ChangeEvent<any>;
        // If we can, persist the event, https://reactjs.org/docs/events.html#event-pooling
        if (event.persist) {
          event.persist();
        }
        const { type, name, id, checked, outerHTML } = event.target;
        field = maybePath ? maybePath : name ? name : id;
        if (!field && process.env.NODE_ENV !== 'production') {
          warnAboutMissingIdentifier({
            htmlContent: outerHTML,
            documentationAnchorLink: 'handlechange-e-reactchangeeventany--void',
            handlerName: 'handleChange',
          });
        }
        value = event.target.value;
        if (/number|range/.test(type)) {
          const parsed = parseFloat(event.target.value);
          value = isNaN(parsed) ? '' : parsed;
        }
        if (/checkbox/.test(type)) {
          value = checked;
        }
      } else {
        value = eventOrValue;
      }

      if (field) {
        // Set form fields by name
        this.setState(
          prevState => ({
            ...prevState,
            values: setIn(prevState.values, field!, value),
          }),
          () => {
            if (this.props.validateOnChange) {
              this.runValidations(setIn(this.state.values, field!, value));
            }
          }
        );
      }
    };

    // Actually execute logic above....
    if (isString(eventOrPath)) {
      const path = eventOrPath;
      // cache these handlers by key like Preact's linkState does for perf boost
      if (!isFunction(this.hcCache[path])) {
        // set a new handle function in cache
        this.hcCache[path] = (eventOrValue: unknown | React.ChangeEvent<any>) =>
          executeChange(eventOrValue, path);
      }
      return this.hcCache[path]; // return the cached function
    } else {
      const event = eventOrPath;
      executeChange(event);
    }
  };

  setFieldValue = (
    field: string,
    value: any,
    shouldValidate: boolean = true
  ) => {
    if (this.didMount) {
      // Set form field by name
      this.setState(
        prevState => ({
          ...prevState,
          values: setIn(prevState.values, field, value),
        }),
        () => {
          if (this.props.validateOnChange && shouldValidate) {
            this.runValidations(this.state.values);
          }
        }
      );
    }
  };

  handleSubmit = (e: React.FormEvent<HTMLFormElement> | undefined) => {
    if (e && e.preventDefault) {
      e.preventDefault();
    }

    // Warn if form submission is triggered by a <button> without a
    // specified `type` attribute during development. This mitigates
    // a common gotcha in forms with both reset and submit buttons,
    // where the dev forgets to add type="button" to the reset button.
    if (
      process.env.NODE_ENV !== 'production' &&
      typeof document !== 'undefined'
    ) {
      // Safely get the active element (works with IE)
      const activeElement = getActiveElement();
      if (
        activeElement !== null &&
        activeElement instanceof HTMLButtonElement
      ) {
        warning(
          !!(
            activeElement.attributes &&
            activeElement.attributes.getNamedItem('type')
          ),
          'You submitted a Formik form using a button with an unspecified `type` attribute.  Most browsers default button elements to `type="submit"`. If this is not a submit button, please add `type="button"`.'
        );
      }
    }

    this.submitForm();
  };

  submitForm = () => {
    // Recursively set all values to `true`.
    this.setState(prevState => ({
      touched: setNestedObjectValues<FormikTouched<Values>>(
        prevState.values,
        true
      ),
      isSubmitting: true,
      isValidating: true,
      submitCount: prevState.submitCount + 1,
    }));

    return this.runValidations(this.state.values).then(combinedErrors => {
      if (this.didMount) {
        this.setState({ isValidating: false });
      }
      const isValid = Object.keys(combinedErrors).length === 0;
      if (isValid) {
        // this.executeSubmit();
        return Promise.resolve(this.executeSubmit());
      } else if (this.didMount) {
        // ^^^ Make sure Formik is still mounted before calling setState
        this.setState({ isSubmitting: false });
      }
      return;
    });
  };

  executeSubmit = () => {
    // this.props.onSubmit(this.state.values, this.getFormikActions());
    return this.props.onSubmit(this.state.values, this.getFormikActions());
  };

  handleBlur = (
    eventOrPath: string | React.FocusEvent<any>
  ): void | ((e?: React.FocusEvent<any>) => void) => {
    const executeBlur = (
      maybeEvent?: React.FocusEvent<any>,
      maybePath?: string
    ) => {
      let field = maybePath;
      if (isInputEvent(maybeEvent)) {
        const event = maybeEvent as React.FocusEvent<any>;
        // If we can, persist the event, https://reactjs.org/docs/events.html#event-pooling
        if (event.persist) {
          event.persist();
        }
        const { name, id, outerHTML } = event.target;
        field = name ? name : id;
        if (!field && process.env.NODE_ENV !== 'production') {
          warnAboutMissingIdentifier({
            htmlContent: outerHTML,
            documentationAnchorLink: 'handleblur-e-reactfocuseventany--void',
            handlerName: 'handleBlur',
          });
        }
      }

      this.setState(prevState => ({
        touched: setIn(prevState.touched, field!, true),
      }));

      if (this.props.validateOnBlur) {
        this.runValidations(this.state.values);
      }
    };
    if (isString(eventOrPath)) {
      const path = eventOrPath;
      // cache these handlers by key like Preact's linkState does for perf boost
      if (!isFunction(this.hbCache[path])) {
        // set a new handle function in cache
        this.hbCache[path] = (event?: React.FocusEvent<any>) =>
          executeBlur(event, path);
      }
      return this.hbCache[path]; // return the cached function
    } else {
      const event = eventOrPath;
      executeBlur(event);
    }
  };

  setFieldTouched = (
    field: string,
    touched: boolean = true,
    shouldValidate: boolean = true
  ) => {
    // Set touched field by name
    this.setState(
      prevState => ({
        ...prevState,
        touched: setIn(prevState.touched, field, touched),
      }),
      () => {
        if (this.props.validateOnBlur && shouldValidate) {
          this.runValidations(this.state.values);
        }
      }
    );
  };

  setFieldError = (field: string, message: string | undefined) => {
    // Set form field by name
    this.setState(prevState => ({
      ...prevState,
      errors: setIn(prevState.errors, field, message),
    }));
  };

  resetForm = (nextValues?: Values) => {
    const values = nextValues ? nextValues : this.props.initialValues;

    this.initialValues = values;

    this.setState({
      isSubmitting: false,
      isValidating: false,
      errors: {},
      touched: {},
      error: undefined,
      status: this.props.initialStatus,
      values,
      submitCount: 0,
    });
  };

  handleReset = () => {
    if (this.props.onReset) {
      const maybePromisedOnReset = (this.props.onReset as any)(
        this.state.values,
        this.getFormikActions()
      );

      if (isPromise(maybePromisedOnReset)) {
        (maybePromisedOnReset as Promise<any>).then(this.resetForm);
      } else {
        this.resetForm();
      }
    } else {
      this.resetForm();
    }
  };

  setFormikState = (s: any, callback?: (() => void)) =>
    this.setState(s, callback);

  validateForm = (values: Values) => {
    this.setState({ isValidating: true });
    return this.runValidations(values).then(errors => {
      if (this.didMount) {
        this.setState({ isValidating: false });
      }
      return errors;
    });
  };

  getFormikActions = (): FormikActions<Values> => {
    return {
      resetForm: this.resetForm,
      submitForm: this.submitForm,
      validateForm: this.validateForm,
      validateField: this.validateField,
      setError: this.setError,
      setErrors: this.setErrors,
      setFieldError: this.setFieldError,
      setFieldTouched: this.setFieldTouched,
      setFieldValue: this.setFieldValue,
      setStatus: this.setStatus,
      setSubmitting: this.setSubmitting,
      setTouched: this.setTouched,
      setValues: this.setValues,
      setFormikState: this.setFormikState,
    };
  };

  getFormikComputedProps = () => {
    const { isInitialValid } = this.props;
    const dirty = !isEqual(this.initialValues, this.state.values);
    return {
      dirty,
      isValid: dirty
        ? this.state.errors && Object.keys(this.state.errors).length === 0
        : isInitialValid !== false && isFunction(isInitialValid)
          ? (isInitialValid as (props: this['props']) => boolean)(this.props)
          : (isInitialValid as boolean),
      initialValues: this.initialValues,
    };
  };

  getFormikBag = () => {
    return {
      ...this.state,
      ...this.getFormikActions(),
      ...this.getFormikComputedProps(),
      // Field needs to communicate with Formik during resets
      registerField: this.registerField,
      unregisterField: this.unregisterField,
      handleBlur: this.handleBlur,
      handleChange: this.handleChange,
      handleReset: this.handleReset,
      handleSubmit: this.handleSubmit,
      validateOnChange: this.props.validateOnChange,
      validateOnBlur: this.props.validateOnBlur,
    };
  };

  getFormikContext = () => {
    return {
      ...this.getFormikBag(),
      validationSchema: this.props.validationSchema,
      validate: this.props.validate,
      initialValues: this.initialValues,
    };
  };

  render() {
    const { component, render, children } = this.props;
    const props = this.getFormikBag();
    const ctx = this.getFormikContext();
    return (
      <FormikProvider value={ctx}>
        {component
          ? React.createElement(component as any, props)
          : render
            ? render(props)
            : children // children come last, always called
              ? isFunction(children)
                ? (children as ((
                    props: FormikProps<Values>
                  ) => React.ReactNode))(props as FormikProps<Values>)
                : !isEmptyChildren(children)
                  ? React.Children.only(children)
                  : null
              : null}
      </FormikProvider>
    );
  }
}

function warnAboutMissingIdentifier({
  htmlContent,
  documentationAnchorLink,
  handlerName,
}: {
  htmlContent: string;
  documentationAnchorLink: string;
  handlerName: string;
}) {
  console.warn(
    `Warning: Formik called \`${handlerName}\`, but you forgot to pass an \`id\` or \`name\` attribute to your input:

    ${htmlContent}

    Formik cannot determine which value to update. For more info see https://github.com/jaredpalmer/formik#${documentationAnchorLink}
  `
  );
}

/**
 * Transform Yup ValidationError to a more usable object
 */
export function yupToFormErrors<Values>(yupError: any): FormikErrors<Values> {
  let errors: any = {} as FormikErrors<Values>;
  if (yupError.inner.length === 0) {
    return setIn(errors, yupError.path, yupError.message);
  }
  for (let err of yupError.inner) {
    if (!errors[err.path]) {
      errors = setIn(errors, err.path, err.message);
    }
  }
  return errors;
}

/**
 * Validate a yup schema.
 */
export function validateYupSchema<T extends FormikValues>(
  values: T,
  schema: any,
  sync: boolean = false,
  context: any = {}
): Promise<Partial<T>> {
  let validateData: Partial<T> = {};
  for (let k in values) {
    if (values.hasOwnProperty(k)) {
      const key = String(k);
      validateData[key] = values[key] !== '' ? values[key] : undefined;
    }
  }
  return schema[sync ? 'validateSync' : 'validate'](validateData, {
    abortEarly: false,
    context: context,
  });
}

/**
 * deepmerge array merging algorithm
 * https://github.com/KyleAMathews/deepmerge#combine-array
 */
function arrayMerge(target: any[], source: any[], options: any): any[] {
  const destination = target.slice();

  source.forEach(function(e: any, i: number) {
    if (typeof destination[i] === 'undefined') {
      const cloneRequested = options.clone !== false;
      const shouldClone = cloneRequested && options.isMergeableObject(e);
      destination[i] = shouldClone
        ? deepmerge(Array.isArray(e) ? [] : {}, e, options)
        : e;
    } else if (options.isMergeableObject(e)) {
      destination[i] = deepmerge(target[i], e, options);
    } else if (target.indexOf(e) === -1) {
      destination.push(e);
    }
  });
  return destination;
}
